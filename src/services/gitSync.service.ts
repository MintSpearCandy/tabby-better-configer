import { Injectable, Inject } from '@angular/core'
import { app } from '@electron/remote'
import * as fs from 'fs'
import * as path from 'path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { ConfigMapService } from './configMap.service'
import { SyncLogService } from './syncLog.service'

/** Minimal source shape this engine needs (full type lives in
 *  syncSources.service.ts — kept structural to avoid a circular import). */
export interface GitSyncTarget {
    id: string
    /** display name for log lines */
    name?: string
    url: string
    /** upstream REMOTE branch (push target) */
    branch: string
    /** current LOCAL branch (defaults to `branch`) */
    localBranch?: string
    /** package file path inside the repo */
    path: string
}

/** Remote rejected a non-fast-forward push (merge origin first). */
export class PushRejectedError extends Error {
    constructor () {
        super('push rejected: remote branch has newer commits')
    }
}

export interface PackageAtRef {
    content: string
    /** commit oid the package was read from */
    commitOid: string
    message: string
    committedAt: string
}

export interface HistoryEntry {
    oid: string
    message: string
    at: string
    pushed: boolean
}

/** Errors matching this get a proxy hint in the log — on machines where
 *  github.com is intermittently blocked that is almost always the cause. */
const NETWORK_ERROR = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPROTO|EHOSTUNREACH|fetch failed|network|socket hang up|Connection|aborted|tunneling|disconnected before secure TLS/i

/** Proxy is up, but its tunnel died mid-handshake — the proxy node itself
 *  is down/switching (observed in the wild with local VPN proxies). */
const TLS_DROP = /disconnected before secure TLS|socket hang up|ECONNRESET/

/** 401/403: GitHub requires auth for pushes even on PUBLIC repos (reads
 *  work anonymously) — the classic "branch listing works, push fails" case. */
const AUTH_ERROR = /401|403|[Uu]nauthorized|[Ff]orbidden/

/** Empty remote advertisement — a fresh repo with no branches yet. */
const EMPTY_REMOTE = /no refs|empty|does not exist|404/

/** Backoff between network retries (ms) — most proxy blips clear in seconds. */
const RETRY_BACKOFF_MS = [1500, 4000]

/** localhost / 127.0.0.1 / ::1 — never proxy these. */
function isLoopbackUrl (u: string | undefined): boolean {
    if (!u) {
        return false
    }
    try {
        const host = new URL(u).hostname
        return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    } catch {
        return false
    }
}

/**
 * Git engine over isomorphic-git (bundled — no system git, no native
 * modules; https remotes only, token auth).
 *
 * IDE MODEL: each source owns a real cache repo at
 * <userData>/better-configer/git/<source-id> whose LOCAL branches stage
 * config packages between the live config and the remote. Commits are
 * built directly from blobs (writeBlob→writeTree→writeCommit) — the
 * worktree is a convenience mirror, flows below never depend on it.
 */
@Injectable({ providedIn: 'root' })
export class GitSyncService {
    private dirCache = new Map<string, string>()
    private adapterCache: { forProxy: string | null, adapter: any } | null = null

    constructor (
        @Inject(ConfigMapService) private map: ConfigMapService,
        private syncLog: SyncLogService,
    ) { }

    cacheRoot (): string {
        return path.join(app.getPath('userData'), 'better-configer', 'git')
    }

    dirFor (sourceId: string): string {
        let dir = this.dirCache.get(sourceId)
        if (!dir) {
            // ids are our own uuids; strip anything path-like anyway
            dir = path.join(this.cacheRoot(), sourceId.replace(/[^a-zA-Z0-9_-]/g, ''))
            this.dirCache.set(sourceId, dir)
        }
        return dir
    }

    dropCache (sourceId: string): void {
        const dir = this.dirFor(sourceId)
        fs.rmSync(dir, { recursive: true, force: true })
    }

    localBranchOf (source: GitSyncTarget): string {
        return source.localBranch || source.branch
    }

    // ------------------------------------------------------------- proxy ----

    /** Effective proxy URL: betterConfiger.sync.proxyUrl, else the standard
     *  HTTPS_PROXY/https_proxy environment variables. Null = direct. */
    proxyUrl (): string | null {
        try {
            const configured = this.map.rawStore()?.betterConfiger?.sync?.proxyUrl
            if (typeof configured === 'string' && configured.trim()) {
                return configured.trim()
            }
        } catch {
            // fall through to env
        }
        return process.env.HTTPS_PROXY
            || process.env.https_proxy
            || process.env.HTTP_PROXY
            || process.env.http_proxy
            || null
    }

    /** http adapter with an optional proxy agent bolted on (cached per proxy
     *  URL). isomorphic-git's node adapter forwards `agent` to node http.
     *  - LOOPBACK TARGETS BYPASS THE PROXY: local git servers (E2E fixtures,
     *    self-hosted instances) must not be routed through an external proxy —
     *    most proxies hang up on localhost anyway.
     *  - keepAlive on the proxy agent lets the info/refs + pack requests of
     *    one git op share their TLS tunnels instead of handshaking twice.
     *  - every request is timed and logged at DEBUG level — that is where
     *    "why is my push slow" questions get answered. */
    private httpAdapter (): any {
        const proxy = this.proxyUrl()
        if (this.adapterCache && this.adapterCache.forProxy === proxy) {
            return this.adapterCache.adapter
        }
        const timed = (send: (req: any) => any) => (req: any) => {
            const started = Date.now()
            const short = String(req?.url ?? '').replace(/^https?:\/\/[^/]+/, '')
            return Promise.resolve(send(req)).then(
                res => {
                    this.syncLog.debug('http', `${req?.method ?? 'GET'} ${short.slice(0, 90)} → ${res?.statusCode} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
                    return res
                },
                e => {
                    this.syncLog.debug('http', `${req?.method ?? 'GET'} ${short.slice(0, 90)} FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s`)
                    throw e
                },
            )
        }
        let adapter: any
        if (proxy) {
            const agent = new HttpsProxyAgent(proxy, { keepAlive: true } as any)
            this.syncLog.debug('http', `using proxy ${proxy} (keepAlive)`)
            adapter = {
                request: timed((req: any) => http.request(
                    isLoopbackUrl(req?.url)
                        ? (this.syncLog.debug('http', `loopback ${String(req?.url ?? '').slice(0, 60)} — bypassing proxy`), req)
                        : { ...req, agent })),
            }
        } else {
            this.syncLog.debug('http', 'no proxy configured — direct connections')
            adapter = { request: timed((req: any) => http.request(req)) }
        }
        this.adapterCache = { forProxy: proxy, adapter }
        return adapter
    }

    private onAuthFor (token: string | null) {
        if (!token) {
            return undefined
        }
        return () => ({ username: 'x-access-token', password: token })
    }

    private label (source: GitSyncTarget): string {
        return source.name || source.id
    }

    // ------------------------------------------------ retry + error hints ----

    /** Wrap an engine op: transient NETWORK failures are retried with a short
     *  backoff (proxy blips clear in seconds); the final failure lands in the
     *  sync log with a proxy/auth hint, then rethrows to the caller. Auth
     *  errors and push rejections are not retried. */
    private async logged<T> (op: string, label: string, fn: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn()
            } catch (e: any) {
                const msg = String(e?.message ?? e)
                const transient = !(e instanceof PushRejectedError)
                    && NETWORK_ERROR.test(msg) && !AUTH_ERROR.test(msg)
                if (transient && attempt <= RETRY_BACKOFF_MS.length) {
                    this.syncLog.info(op, `${label}: ${msg} — retrying (${attempt + 1}/${RETRY_BACKOFF_MS.length + 1})`)
                    await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]))
                    this.syncLog.debug(op, `retry backoff ${RETRY_BACKOFF_MS[attempt - 1]}ms done`)
                    continue
                }
                if (!(e instanceof PushRejectedError)) {
                    const hint = AUTH_ERROR.test(msg)
                        ? this.authHint()
                        : NETWORK_ERROR.test(msg) ? this.networkHint(msg) : undefined
                    this.syncLog.error(op, `${label}: ${msg}`, hint)
                }
                throw e
            }
        }
    }

    private networkHint (msg: string): string {
        const proxy = this.proxyUrl()
        if (proxy) {
            if (TLS_DROP.test(msg)) {
                return `the proxy ${proxy} accepted the connection but dropped it before TLS completed — the proxy node itself looks down/switching; wait or switch the node, then retry`
            }
            return `all git traffic currently goes through the proxy ${proxy} — if that is the repo URL or a wrong address, clear/fix the proxy field (it must be an http:// proxy, e.g. http://127.0.0.1:7890)`
        }
        return 'no proxy is configured — if github.com is blocked on your network, set an HTTP proxy in the sync header (e.g. http://127.0.0.1:7890)'
    }

    private authHint (): string {
        return 'auth rejected — git PUSHES need an access token even on public repos (reads can be anonymous). Open the source editor and set a token (stored in the vault when available); private repos need it for reads too'
    }

    // -------------------------------------------------------------- repo ----

    /** Create/repair the cache repo (no history nuking — branches are durable
     *  now) and retarget the remote. */
    private async ensureRepo (source: GitSyncTarget): Promise<string> {
        const dir = this.dirFor(source.id)
        this.syncLog.debug('cache', `ensureRepo ${this.label(source)} (${source.id.slice(0, 8)}) -> ${dir}`)
        if (!fs.existsSync(path.join(dir, '.git'))) {
            fs.rmSync(dir, { recursive: true, force: true })
            fs.mkdirSync(dir, { recursive: true })
            await git.init({ fs, dir, defaultBranch: 'main' })
            this.syncLog.info('cache', `created cache repo for "${this.label(source)}"`)
        }
        const remotes = await git.listRemotes({ fs, dir })
        const origin = remotes.find(r => r.remote === 'origin')
        if (!origin) {
            await git.addRemote({ fs, dir, remote: 'origin', url: source.url })
        } else if (origin.url !== source.url) {
            await git.deleteRemote({ fs, dir, remote: 'origin' })
            await git.addRemote({ fs, dir, remote: 'origin', url: source.url })
        }
        return dir
    }

    // ------------------------------------------------------------- fetch ----

    /** Fetch ALL remote heads (merge targets may be any origin/* branch). An
     *  empty/fresh remote is not an error — it just has no heads yet. */
    async fetchAll (source: GitSyncTarget, token: string | null): Promise<string[]> {
        return this.logged('fetch', this.label(source), async () => {
            const dir = await this.ensureRepo(source)
            const started = Date.now()
            try {
                await git.fetch({ fs, http: this.httpAdapter(), dir, remote: 'origin', onAuth: this.onAuthFor(token) })
            } catch (e: any) {
                if (EMPTY_REMOTE.test(String(e?.message ?? e))) {
                    this.syncLog.debug('fetch', 'remote has no refs yet (fresh repo)')
                    return []
                }
                throw e
            }
            const heads = await this.listRemoteBranches(source)
            this.syncLog.info('fetch', `fetched ${heads.length} branches from ${this.sourceUrl(source)} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
            return heads
        })
    }

    /** Remote branch names as known from the last fetch (local refs).
     *  isomorphic-git's remote listing includes a literal 'HEAD' symref —
     *  filtered out (it is not a branch). */
    async listRemoteBranches (source: GitSyncTarget): Promise<string[]> {
        const dir = await this.ensureRepo(source)
        const branches = await git.listBranches({ fs, dir, remote: 'origin' })
        return branches.filter(b => b !== 'HEAD').sort()
    }

    /** Live branch list straight from the server (source editor picker). */
    async listServerBranches (url: string, token: string | null): Promise<string[]> {
        return this.logged('branches', url, async () => {
            const refs = await git.listServerRefs({
                url,
                http: this.httpAdapter(),
                onAuth: this.onAuthFor(token),
                prefix: 'refs/heads/',
            })
            const branches = refs.map(r => r.ref.replace(/^refs\/heads\//, '')).sort()
            this.syncLog.info('branches', `listed ${branches.length} branches from ${url}`)
            return branches
        })
    }

    private sourceUrl (source: GitSyncTarget): string {
        return source.url.replace(/^https?:\/\/[^/]+/, '') || source.url
    }

    // ----------------------------------------------------------- branches ----

    async listLocalBranches (source: GitSyncTarget): Promise<string[]> {
        const dir = await this.ensureRepo(source)
        return (await git.listBranches({ fs, dir })).sort()
    }

    async branchHeadOid (source: GitSyncTarget, branch: string): Promise<string | null> {
        const dir = await this.ensureRepo(source)
        try {
            return await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` })
        } catch {
            return null
        }
    }

    async remoteHeadOid (source: GitSyncTarget, branch: string): Promise<string | null> {
        const dir = await this.ensureRepo(source)
        try {
            return await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` })
        } catch {
            return null
        }
    }

    /** 'main' → refs/heads/main; 'origin/main' → refs/remotes/origin/main;
     *  full refs and raw 40-hex oids pass through unchanged. */
    private fullRef (ref: string): string {
        if (/^[0-9a-f]{40}$/i.test(ref)) {
            return ref // raw oid — resolveRef takes it directly
        }
        if (ref.startsWith('origin/')) {
            return `refs/remotes/${ref}`
        }
        if (ref.startsWith('refs/')) {
            return ref
        }
        return `refs/heads/${ref}`
    }

    /** Create a local branch at fromRef ('origin/x', local branch, oid).
     *  Without fromRef: at the remote branch of the same name, else at HEAD. */
    async createBranch (source: GitSyncTarget, name: string, fromRef?: string): Promise<void> {
        const dir = await this.ensureRepo(source)
        let base: string | null = null
        if (fromRef) {
            base = await this.resolveRef(source, fromRef)
        } else {
            base = await this.remoteHeadOid(source, name)
                ?? await this.branchHeadOid(source, this.localBranchOf(source))
        }
        if (base) {
            await git.branch({ fs, dir, ref: name, object: base })
            this.syncLog.info('branch', `created ${name} at ${base.slice(0, 8)} (${this.label(source)})`)
        } else {
            // no commits anywhere yet — point HEAD at the unborn branch
            await git.writeRef({ fs, dir, ref: 'HEAD', value: `ref: refs/heads/${name}`, symbolic: true, force: true })
            this.syncLog.info('branch', `HEAD moved to (unborn) ${name} (${this.label(source)})`)
        }
    }

    async switchBranch (source: GitSyncTarget, name: string): Promise<void> {
        const dir = await this.ensureRepo(source)
        if (!(await this.listLocalBranches(source)).includes(name)) {
            await this.createBranch(source, name, `origin/${name}`)
        }
        const head = await this.branchHeadOid(source, name)
        await git.writeRef({ fs, dir, ref: 'HEAD', value: `ref: refs/heads/${name}`, symbolic: true, force: true })
        if (head) {
            // populate the worktree mirror (flows never depend on it)
            await git.checkout({ fs, dir, ref: name, force: true }).catch(() => null)
        }
        this.syncLog.info('branch', `switched to ${name} (${this.label(source)})`)
    }

    async deleteBranch (source: GitSyncTarget, name: string): Promise<void> {
        const dir = await this.ensureRepo(source)
        if (name === this.localBranchOf(source)) {
            throw new Error('cannot delete the current branch')
        }
        await git.deleteBranch({ fs, dir, ref: name })
        this.syncLog.info('branch', `deleted ${name} (${this.label(source)})`)
    }

    // ---------------------------------------------------------- packages ----

    private async resolveRef (source: GitSyncTarget, ref: string): Promise<string | null> {
        const dir = await this.ensureRepo(source)
        try {
            return await git.resolveRef({ fs, dir, ref: this.fullRef(ref) })
        } catch {
            return null
        }
    }

    /** Package file content at a ref (local branch, 'origin/x', oid).
     *  null = branch missing or no package file there yet (unborn/new). */
    async readPackageAt (source: GitSyncTarget, ref: string): Promise<PackageAtRef | null> {
        const dir = await this.ensureRepo(source)
        const commitOid = await this.resolveRef(source, ref)
        if (!commitOid) {
            return null
        }
        const commit = await git.readCommit({ fs, dir, oid: commitOid })
        let blob: Uint8Array
        try {
            blob = (await git.readBlob({ fs, dir, oid: commitOid, filepath: source.path })).blob
        } catch {
            return null // branch exists, package file not yet committed
        }
        this.syncLog.debug('read', `read ${source.path} @ ${ref} (${commitOid.slice(0, 8)})`)
        return {
            content: Buffer.from(blob).toString('utf8'),
            commitOid,
            message: commit.commit.message.trim().split('\n')[0],
            committedAt: new Date(commit.commit.author.timestamp * 1000).toISOString(),
        }
    }

    /** Write a package as a commit on the CURRENT local branch. parents is
     *  explicit: [head] for snapshots, [ours, theirs] for merge commits. */
    async commitPackage (
        source: GitSyncTarget,
        content: string,
        message: string,
        parents: string[],
    ): Promise<string> {
        const dir = await this.ensureRepo(source)
        const branch = this.localBranchOf(source)
        const started = Date.now()
        const blobOid = await git.writeBlob({ fs, dir, blob: Buffer.from(content, 'utf8') })
        const treeOid = await git.writeTree({
            fs, dir,
            tree: [{ path: source.path, mode: '100644', type: 'blob', oid: blobOid }],
        })
        const author = {
            name: 'BetterConfiger',
            email: 'better-configer@tabby.local',
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: -new Date().getTimezoneOffset(),
        }
        const commitOid = await git.writeCommit({
            fs, dir,
            commit: {
                message,
                tree: treeOid,
                parent: parents,
                author,
                committer: author,
            },
        })
        // the branch ref may not exist yet (first commit / unborn) — force covers both
        await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: commitOid, force: true })
        // keep the worktree mirror in step (never load-bearing)
        const file = path.join(dir, source.path)
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, content)
        } catch { /* best-effort */ }
        this.syncLog.debug('commit', `commit ${commitOid.slice(0, 8)} on ${branch} (parents ${parents.length}) in ${((Date.now() - started) / 1000).toFixed(2)}s`)
        return commitOid
    }

    /** Merge base of two commits, or null (unrelated histories). */
    async mergeBase (source: GitSyncTarget, a: string, b: string): Promise<string | null> {
        const dir = await this.ensureRepo(source)
        try {
            const base = await git.findMergeBase({ fs, dir, oids: [a, b] })
            return Array.isArray(base) ? (base[0] ?? null) : (base ?? null)
        } catch (e: any) {
            this.syncLog.debug('merge', `mergeBase(${a.slice(0, 8)}, ${b.slice(0, 8)}) failed: ${String(e?.message ?? e).slice(0, 120)}`)
            return null
        }
    }

    // ------------------------------------------------------------- push ----

    /** Push the CURRENT local branch onto the upstream remote branch. */
    async pushBranch (source: GitSyncTarget, token: string | null, force = false): Promise<string> {
        return this.logged('push', this.label(source), async () => {
            const dir = await this.ensureRepo(source)
            const local = this.localBranchOf(source)
            const head = await this.branchHeadOid(source, local)
            if (!head) {
                throw new Error(`local branch "${local}" has no commits — commit first`)
            }
            const started = Date.now()
            this.syncLog.debug('push', `pushing ${local} -> origin/${source.branch} ...`)
            try {
                const result = await git.push({
                    fs,
                    http: this.httpAdapter(),
                    dir,
                    remote: 'origin',
                    ref: local,
                    remoteRef: `refs/heads/${source.branch}`,
                    force,
                    onAuth: this.onAuthFor(token),
                } as any)
                this.syncLog.success('push', `pushed ${local} -> origin/${source.branch} (${head.slice(0, 8)})${force ? ' [force]' : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
                return head
            } catch (e: any) {
                const msg = String(e?.message ?? e)
                if (!force && /fetch first|non-fast-forward|rejected/i.test(msg)) {
                    this.syncLog.error('push', `${this.label(source)}: push rejected — merge origin/${source.branch} first (remote has commits you don't)`)
                    throw new PushRejectedError()
                }
                throw e
            }
        })
    }

    // ------------------------------------------------------ status + log ----

    /** ahead = local-only commits, behind = remote-only commits (vs the last
     *  fetch). Missing remote head → ahead = all local commits. */
    async aheadBehind (source: GitSyncTarget): Promise<{ ahead: number, behind: number }> {
        const dir = await this.ensureRepo(source)
        const local = this.localBranchOf(source)
        const localOid = await this.branchHeadOid(source, local)
        if (!localOid) {
            return { ahead: 0, behind: 0 }
        }
        const localOids = new Set((await git.log({ fs, dir, ref: `refs/heads/${local}` })).map(e => e.oid))
        const remoteOid = await this.remoteHeadOid(source, source.branch)
        if (!remoteOid) {
            return { ahead: localOids.size, behind: 0 }
        }
        const remoteOids = new Set((await git.log({ fs, dir, ref: `refs/remotes/origin/${source.branch}` })).map(e => e.oid))
        let ahead = 0
        let behind = 0
        for (const oid of localOids) {
            if (!remoteOids.has(oid)) {
                ahead++
            }
        }
        for (const oid of remoteOids) {
            if (!localOids.has(oid)) {
                behind++
            }
        }
        return { ahead, behind }
    }

    /** Commit list of the current local branch; entries already on the
     *  upstream are flagged pushed. */
    async history (source: GitSyncTarget, limit = 30): Promise<HistoryEntry[]> {
        const dir = await this.ensureRepo(source)
        const local = this.localBranchOf(source)
        try {
            const entries = await git.log({ fs, dir, ref: `refs/heads/${local}`, depth: limit })
            let pushedSet = new Set<string>()
            try {
                const remote = await git.log({ fs, dir, ref: `refs/remotes/origin/${source.branch}`, depth: limit * 2 })
                pushedSet = new Set(remote.map(e => e.oid))
            } catch { /* no upstream yet */ }
            return entries.map(e => ({
                oid: e.oid,
                message: e.commit.message.trim().split('\n')[0],
                at: new Date(e.commit.author.timestamp * 1000).toISOString(),
                pushed: pushedSet.has(e.oid),
            }))
        } catch {
            return [] // unborn branch
        }
    }

    /** Full log of ALL local+remote refs (for the graph): entries carry
     *  parents and the refs pointing at them. */
    /**
     * Union of all local + remote branches' history, oldest first, each
     * commit carrying every ref that points at it.
     *
     * Cost notes (this runs on every browser reload):
     *  - refs sharing history are common (main and origin/main): a full
     *    `git.log` per ref walked that shared history once per ref. Now the
     *    walk from a ref is skipped when that tip is already covered, and the
     *    ref is simply attached to the commit it names.
     *  - ordering is a Kahn topological sort (O(V+E)); the previous
     *    repeated whole-list scan was O(V²) per reload.
     */
    async graphLog (source: GitSyncTarget, limit = 200): Promise<GraphCommit[]> {
        const dir = await this.ensureRepo(source)
        const heads: Array<{ ref: string, full: string }> = []
        for (const b of await git.listBranches({ fs, dir })) {
            heads.push({ ref: b, full: `refs/heads/${b}` })
        }
        for (const b of await git.listBranches({ fs, dir, remote: 'origin' })) {
            if (b === 'HEAD') {
                continue
            }
            heads.push({ ref: `origin/${b}`, full: `refs/remotes/origin/${b}` })
        }

        const byOid = new Map<string, GraphCommit>()
        const attach = (oid: string, ref: string): void => {
            const c = byOid.get(oid)
            if (c && !c.refs.includes(ref)) {
                c.refs.push(ref)
            }
        }
        const tips: Array<{ oid: string, ref: string }> = []
        for (const head of heads) {
            try {
                tips.push({ oid: await git.resolveRef({ fs, dir, ref: head.full }), ref: head.ref })
            } catch {
                // unborn branch
            }
        }
        for (const tip of tips) {
            if (byOid.has(tip.oid)) {
                attach(tip.oid, tip.ref) // history already walked from another ref
                continue
            }
            let entries: any[] = []
            try {
                entries = await git.log({ fs, dir, ref: tip.oid, depth: limit })
            } catch {
                continue
            }
            for (const e of entries) {
                if (byOid.has(e.oid)) {
                    continue
                }
                byOid.set(e.oid, {
                    oid: e.oid,
                    parents: e.commit.parent.slice(),
                    message: e.commit.message.trim().split('\n')[0],
                    at: new Date(e.commit.author.timestamp * 1000).toISOString(),
                    author: e.commit.author.name,
                    refs: [],
                })
            }
            attach(tip.oid, tip.ref)
        }

        // Kahn topological sort, oldest first: a commit is emitted once all of
        // its known parents have been emitted. Ties break on commit time so
        // parallel branches interleave chronologically.
        const pendingParents = new Map<string, number>()
        const children = new Map<string, string[]>()
        for (const c of byOid.values()) {
            const known = c.parents.filter(p => byOid.has(p))
            pendingParents.set(c.oid, known.length)
            for (const p of known) {
                const list = children.get(p) ?? []
                list.push(c.oid)
                children.set(p, list)
            }
        }
        const ready = [...byOid.values()]
            .filter(c => (pendingParents.get(c.oid) ?? 0) === 0)
            .sort((x, y) => x.at.localeCompare(y.at))
        const sorted: GraphCommit[] = []
        while (ready.length) {
            // take the oldest ready commit
            let best = 0
            for (let i = 1; i < ready.length; i++) {
                if (ready[i].at < ready[best].at) {
                    best = i
                }
            }
            const c = ready.splice(best, 1)[0]
            sorted.push(c)
            for (const childOid of children.get(c.oid) ?? []) {
                const left = (pendingParents.get(childOid) ?? 1) - 1
                pendingParents.set(childOid, left)
                if (left === 0) {
                    ready.push(byOid.get(childOid)!)
                }
            }
        }
        return sorted
    }

    /** Package contents at a commit and at its first parent — the "what
     *  changed in this commit" pair for the diff view. Either side may be
     *  null (root commit / package not yet tracked). */
    async commitPackages (source: GitSyncTarget, oid: string): Promise<{ current: string | null, parent: string | null }> {
        const readAt = async (commitOid: string): Promise<string | null> => {
            try {
                return Buffer.from((await git.readBlob({ fs, dir: await this.ensureRepo(source), oid: commitOid, filepath: source.path })).blob).toString('utf8')
            } catch {
                return null
            }
        }
        const commit = await git.readCommit({ fs, dir: await this.ensureRepo(source), oid })
        return {
            current: await readAt(oid),
            parent: commit.commit.parent[0] ? await readAt(commit.commit.parent[0]) : null,
        }
    }

    /** SOFT reset: move the current local branch to an earlier commit. The
     *  live config is untouched; the next Commit simply re-snapshots on top
     *  of the reset head. */
    async resetTo (source: GitSyncTarget, oid: string): Promise<void> {
        const dir = await this.ensureRepo(source)
        const branch = this.localBranchOf(source)
        await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true })
        this.syncLog.info('branch', `reset ${branch} to ${oid.slice(0, 8)} (soft — config untouched)`)
    }
}

/** One commit as rendered in the graph (refs include local and origin/* names). */
export interface GraphCommit {
    oid: string
    parents: string[]
    message: string
    at: string
    author: string
    refs: string[]
}
