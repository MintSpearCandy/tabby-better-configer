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
    branch: string
    /** package file path inside the repo */
    path: string
}

/** Remote rejected a non-fast-forward push (it has commits we don't). */
export class PushRejectedError extends Error {
    constructor () {
        super('push rejected: remote branch has newer commits')
    }
}

export interface RemoteFile {
    content: string
    oid: string
    message: string
    committedAt: string
}

/** Errors matching this get a proxy hint in the log — on machines where
 *  github.com is intermittently blocked that is almost always the cause. */
const NETWORK_ERROR = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPROTO|EHOSTUNREACH|fetch failed|network|socket hang up|Connection|aborted|tunneling|disconnected before secure TLS/i

/** Proxy is up, but its tunnel died mid-handshake — the proxy node itself
 *  is down/switching (observed in the wild with local VPN proxies). */
const TLS_DROP = /disconnected before secure TLS|socket hang up|ECONNRESET/

/** Backoff between network retries (ms) — most proxy blips clear in seconds. */
const RETRY_BACKOFF_MS = [1500, 4000]

/** 401/403: GitHub requires auth for pushes even on PUBLIC repos (reads
 *  work anonymously) — the classic "branch listing works, push fails" case. */
const AUTH_ERROR = /401|403|[Uu]nauthorized|[Ff]orbidden/

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
 * Pure git engine over isomorphic-git (bundled — no system git needed, no
 * native modules; https remotes only, token auth).
 *
 * Cache layout: <userData>/better-configer/git/<source-id>/ — a real repo
 * whose worktree only ever holds the one package file. A marker file pins
 * the branch the cache was created for; changing it (or a failed repo) simply
 * nukes and re-inits the directory: the cache is disposable by design.
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

    /** Create/reuse the cache repo, retarget the remote, and pin the branch. */
    private async ensureRepo (source: GitSyncTarget): Promise<string> {
        const dir = this.dirFor(source.id)
        const marker = path.join(dir, '.better-configer-branch')
        const markerOk = fs.existsSync(marker)
            && fs.readFileSync(marker, 'utf8').trim() === source.branch
            && fs.existsSync(path.join(dir, '.git'))
        if (!markerOk) {
            fs.rmSync(dir, { recursive: true, force: true })
            fs.mkdirSync(dir, { recursive: true })
            await git.init({ fs, dir, defaultBranch: source.branch })
            fs.writeFileSync(marker, source.branch)
            this.syncLog.info('cache', `rebuilt cache repo for "${this.label(source)}" (branch ${source.branch})`)
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

    /** Remote branch heads for a repo URL (for the branch picker). */
    async listBranches (url: string, token: string | null): Promise<string[]> {
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

    /** Fetch the source branch and return its head oid, or null when the
     *  branch does not exist on the remote yet (fresh repo / new branch). */
    private async fetch (source: GitSyncTarget, token: string | null): Promise<string | null> {
        const dir = await this.ensureRepo(source)
        try {
            await git.fetch({
                fs,
                http: this.httpAdapter(),
                dir,
                remote: 'origin',
                ref: source.branch,
                singleBranch: true,
                onAuth: this.onAuthFor(token),
            })
        } catch (e: any) {
            // a missing branch makes the ref advertisement come back empty;
            // anything else (auth, network, no repo) is a real error
            if (/does not exist|not found|404|no refs|empty/i.test(String(e?.message ?? e))
                && source.branch) {
                try {
                    const resolved = await git.resolveRef({
                        fs, dir, ref: `refs/remotes/origin/${source.branch}`,
                    })
                    return resolved
                } catch {
                    return null
                }
            }
            throw e
        }
        return await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${source.branch}` })
    }

    /** Fetch + read the package file at the branch head. Throws with a
     *  readable message when the branch or the file is missing. */
    async readFile (source: GitSyncTarget, token: string | null): Promise<RemoteFile> {
        return this.logged('pull', this.label(source), async () => {
            const started = Date.now()
            const dir = await this.ensureRepo(source)
            this.syncLog.debug('pull', `fetching origin/${source.branch} ...`)
            const tFetch = Date.now()
            const oid = await this.fetch(source, token)
            this.syncLog.debug('pull', `fetch done in ${((Date.now() - tFetch) / 1000).toFixed(1)}s${oid ? ` (head ${oid.slice(0, 8)})` : ''}`)
            if (!oid) {
                throw new Error(`branch "${source.branch}" does not exist on the remote`)
            }
            const commit = await git.readCommit({ fs, dir, oid })
            let blob: Uint8Array
            try {
                blob = (await git.readBlob({ fs, dir, oid, filepath: source.path })).blob
            } catch {
                throw new Error(`"${source.path}" not found on branch "${source.branch}"`)
            }
            const file: RemoteFile = {
                content: Buffer.from(blob).toString('utf8'),
                oid,
                message: commit.commit.message.trim().split('\n')[0],
                committedAt: new Date(commit.commit.author.timestamp * 1000).toISOString(),
            }
            this.syncLog.info('pull', `fetched ${source.path} @ ${source.branch} (${oid.slice(0, 8)}, ${((Date.now() - started) / 1000).toFixed(1)}s)`, `"${file.message}" ${file.committedAt}`)
            return file
        })
    }

    /** Write the package file, commit, and push the source branch.
     *  force skips the fast-forward check (overwrites remote history). */
    async writeFile (
        source: GitSyncTarget,
        content: string,
        message: string,
        token: string | null,
        force = false,
    ): Promise<{ oid: string }> {
        return this.logged('push', this.label(source), async () => {
            const started = Date.now()
            const dir = await this.ensureRepo(source)
            // Refresh the remote ref first: a first-ever push to a repo that
            // already has the branch must build on its history (fast-forward),
            // not commit a parentless root that can only go through by force.
            // A missing branch (fresh repo) simply fetches nothing — the
            // bootstrap path. This fetch is the bulk of the pre-commit wait
            // (network round trips); the commit itself is local milliseconds.
            this.syncLog.debug('push', `pre-fetching origin/${source.branch} ...`)
            const tFetch = Date.now()
            const fetched = await this.fetch(source, token).catch(() => null)
            this.syncLog.debug('push', `pre-fetch done in ${((Date.now() - tFetch) / 1000).toFixed(1)}s${fetched ? ` (head ${fetched.slice(0, 8)})` : ' — no remote branch (bootstrap)'}`)
            const tReset = Date.now()
            await this.syncWorktreeToBranch(dir, source.branch)
            this.syncLog.debug('push', `worktree on ${source.branch} in ${((Date.now() - tReset) / 1000).toFixed(1)}s`)

            const file = path.join(dir, source.path)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, content)
            await git.add({ fs, dir, filepath: source.path })
            const tCommit = Date.now()
            const oid = await git.commit({
                fs,
                dir,
                message,
                author: { name: 'BetterConfiger', email: 'better-configer@tabby.local' },
            })
            this.syncLog.debug('push', `commit built in ${((Date.now() - tCommit) / 1000).toFixed(2)}s`)
            this.syncLog.info('push', `commit ${oid.slice(0, 8)} on ${source.branch}`, message)
            this.syncLog.debug('push', 'pushing to origin ...')
            const tPush = Date.now()
            try {
                await git.push({
                    fs,
                    http: this.httpAdapter(),
                    dir,
                    remote: 'origin',
                    ref: source.branch,
                    force,
                    onAuth: this.onAuthFor(token),
                })
            } catch (e: any) {
                const msg = String(e?.message ?? e)
                if (!force && /fetch first|non-fast-forward|rejected/i.test(msg)) {
                    this.syncLog.error('push', `${this.label(source)}: push rejected — remote branch has newer commits (non-fast-forward)`)
                    throw new PushRejectedError()
                }
                throw e
            }
            this.syncLog.debug('push', `push round trip done in ${((Date.now() - tPush) / 1000).toFixed(1)}s`)
            this.syncLog.success('push', `pushed ${source.branch} -> origin (${oid.slice(0, 8)})${force ? ' [force]' : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
            return { oid }
        })
    }

    /** Point the worktree (and HEAD) at the target branch before committing.
     *
     *  REMOTE WINS: the cache is disposable by design and the package file is
     *  fully regenerated on every push — so when the fetched remote branch
     *  exists, the local branch is (re)pointed at it and checked out. The
     *  commit then lands on top of the remote's latest history and the push
     *  fast-forwards (rejections shrink to the tiny fetch→push race, where
     *  the force-push confirm remains the escape hatch). Local-only commits
     *  (e.g. left behind by a FAILED push) are never precious and get
     *  discarded. No remote ref → unborn HEAD stays (bootstrap push).
     */
    private async syncWorktreeToBranch (dir: string, branch: string): Promise<void> {
        let remoteHead: string | null = null
        try {
            remoteHead = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` })
        } catch {
            // branch not on the remote (yet)
        }
        if (remoteHead) {
            // detach at the remote head first — re-pointing the branch that
            // is currently checked out is refused; from a detached HEAD it
            // is a plain ref update
            await git.checkout({ fs, dir, ref: remoteHead, force: true })
            await git.branch({ fs, dir, ref: branch, object: remoteHead, force: true })
            await git.checkout({ fs, dir, ref: branch, force: true })
            return
        }
        let headUnborn = false
        try {
            await git.resolveRef({ fs, dir, ref: 'HEAD' })
        } catch {
            headUnborn = true
        }
        if (headUnborn) {
            return // init() created HEAD at the target branch already
        }
        const branches = await git.listBranches({ fs, dir })
        if (!branches.includes(branch)) {
            await git.branch({ fs, dir, ref: branch })
        }
        await git.checkout({ fs, dir, ref: branch, force: true })
    }
}
