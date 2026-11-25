import { Injectable } from '@angular/core'
import { ConfigService, VaultService } from 'tabby-core'
import * as crypto from 'crypto'
import * as yaml from 'js-yaml'

import { ConfigMapService } from './configMap.service'
import { PackageIOService, ConfigPackage, ApplyResult } from './packageIO.service'
import { GitSyncService, GitSyncTarget, HistoryEntry, PushRejectedError } from './gitSync.service'
import { PackageMergeService, MergeDraft } from './packageMerge.service'
import { SyncLogService } from './syncLog.service'

export const VAULT_TOKEN_TYPE = 'better-configer-git-token'

/** One git sync source = repo + upstream branch + local branch + package
 *  file + apply mode. Persisted under `betterConfiger.sync.sources` — EXCEPT
 *  the token, which goes to the Tabby vault when available (tokenPlain is
 *  the plaintext fallback for vault-less setups). */
export interface SyncSource extends GitSyncTarget {
    name: string
    mode: 'merge' | 'replace'
    /** push/commit: include vault/encrypted/configSync sections */
    includeSensitive: boolean
    tokenInVault?: boolean
    tokenPlain?: string
    lastPull?: { at: string, oid: string, message: string }
    lastPush?: { at: string, oid: string }
}

/** Everything the workspace panel renders for one source. */
export interface WorkspaceState {
    localBranch: string
    localBranches: string[]
    remoteBranches: string[]
    ahead: number
    behind: number
    /** package at the local branch head; null = unborn branch */
    headPackage: ConfigPackage | null
    history: HistoryEntry[]
    /** sections where the live config differs from the head package */
    configDiff: string[]
}

/** Merge in progress — handed to the UI when conflicts need resolutions. */
export interface MergeUiDraft extends MergeDraft {
    baseMissing: boolean
}

/** Sections never committed: plugin-self configuration (toggles, source
 *  list, token fallbacks) is machine-local by design. */
const NEVER_COMMIT_KEYS = ['version', 'betterConfiger']

/**
 * Workspace orchestration over the git engine: the IDE-model flow
 * config ⇄ local branch ⇄ remote, with semantic three-way merges.
 */
@Injectable({ providedIn: 'root' })
export class SyncSourcesService {
    /** Workspace UI state kept HERE (root singleton) so switching sub-tabs —
     *  which destroys/recreates the sync panel — keeps workspaces expanded
     *  with their loaded state. */
    wsCache = new Map<string, WorkspaceState>()
    expandedWsId: string | null = null
    historyFor: string | null = null

    constructor (
        private config: ConfigService,
        private map: ConfigMapService,
        private io: PackageIOService,
        /** public: the git browser component drives the engine directly */
        public readonly git: GitSyncService,
        private mergeSvc: PackageMergeService,
        private vault: VaultService,
        private syncLog: SyncLogService,
    ) { }

    get vaultAvailable (): boolean {
        try {
            return this.vault.isEnabled() && this.vault.isOpen()
        } catch {
            return false
        }
    }

    // -------------------------------------------------------------- CRUD ----

    sources (): SyncSource[] {
        const raw = this.map.rawStore()
        const list = raw?.betterConfiger?.sync?.sources
        return Array.isArray(list) ? list : []
    }

    newId (): string {
        return crypto.randomUUID()
    }

    proxyUrl (): string {
        return this.map.rawStore()?.betterConfiger?.sync?.proxyUrl ?? ''
    }

    /** Whether the sync log window also shows debug-level lines. */
    logDebug (): boolean {
        return this.map.rawStore()?.betterConfiger?.sync?.logDebug === true
    }

    /** Empty string clears the override (env vars take over again). */
    async setProxyUrl (value: string): Promise<void> {
        const raw = this.map.rawStore()
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        if (value.trim()) {
            raw.betterConfiger.sync.proxyUrl = value.trim()
        } else {
            delete raw.betterConfiger.sync.proxyUrl
        }
        await this.config.writeRaw(yaml.dump(raw))
        this.syncLog.info('source', value.trim() ? `proxy set to ${value.trim()}` : 'proxy cleared')
    }

    async setLogDebug (value: boolean): Promise<void> {
        const raw = this.map.rawStore()
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        raw.betterConfiger.sync.logDebug = value
        await this.config.writeRaw(yaml.dump(raw))
    }

    async saveSource (src: SyncSource): Promise<void> {
        const sources = this.sources().filter(s => s.id !== src.id)
        sources.push(src)
        await this.persistSources(sources)
        this.syncLog.info('source', `saved source "${src.name}"`, `${src.url} — local ${src.localBranch || src.branch} → origin/${src.branch} : ${src.path}`)
    }

    async deleteSource (id: string): Promise<void> {
        const src = this.sources().find(s => s.id === id)
        await this.setToken({ ...src, id } as SyncSource, null)
            .catch(() => null)
        this.git.dropCache(id)
        const raw = this.map.rawStore()
        const remaining = (raw?.betterConfiger?.sync?.sources ?? []).filter((s: SyncSource) => s.id !== id)
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        raw.betterConfiger.sync.sources = remaining
        await this.config.writeRaw(yaml.dump(raw))
        this.syncLog.info('source', `deleted source "${src?.name ?? id}" (cache dropped)`)
    }

    // ------------------------------------------------------------- token ----

    /** Token from the vault when available, else the plaintext fallback. */
    async getToken (source: SyncSource): Promise<string | null> {
        if (this.vaultAvailable) {
            const secret = await this.vault
                .getSecret(VAULT_TOKEN_TYPE, { id: source.id })
                .catch(() => null)
            if (secret) {
                return secret.value
            }
        }
        return source.tokenPlain || null
    }

    /** Store the token in the vault (when available), or clear it. The
     *  plaintext fallback is persisted through the normal source save. */
    async setToken (source: SyncSource, token: string | null): Promise<void> {
        if (!this.vaultAvailable) {
            return
        }
        const key = { id: source.id }
        const existing = await this.vault.getSecret(VAULT_TOKEN_TYPE, key).catch(() => null)
        if (token) {
            const secret = { type: VAULT_TOKEN_TYPE, key, value: token }
            if (existing) {
                await this.vault.updateSecret(existing, secret)
            } else {
                await this.vault.addSecret(secret)
            }
            this.syncLog.info('source', `token for "${source.name ?? source.id}" stored in the vault`)
        } else if (existing) {
            await this.vault.removeSecret(VAULT_TOKEN_TYPE, key)
            this.syncLog.info('source', `token for "${source.name ?? source.id}" removed from the vault`)
        }
    }

    // ------------------------------------------------------- workspaces ----

    /** The current config serialized as a package (sections excluded from
     *  commits: plugin-self + sensitive unless the source opts in). */
    currentPackage (source: SyncSource): ConfigPackage {
        const json = this.io.serializePackage('full', this.commitKeys(source), source.includeSensitive)
        return JSON.parse(json)
    }

    commitKeys (source: SyncSource): string[] {
        const raw = this.map.rawStore()
        return Object.keys(raw).filter(k => !NEVER_COMMIT_KEYS.includes(k))
    }

    /** Load everything the workspace shows. Local-only (no network) EXCEPT
     *  the first open of a fresh source: no cached remote refs + unborn local
     *  branch → one fetch + adopt, so the workspace opens on a real head
     *  instead of an empty unborn branch (IDE-like first-open experience). */
    async loadWorkspace (source: SyncSource): Promise<WorkspaceState> {
        const local = this.git.localBranchOf(source)
        const localBranches = await this.git.listLocalBranches(source)
        if (!localBranches.includes(local)) {
            await this.git.createBranch(source, local, `origin/${source.branch}`)
        }
        let headRaw = await this.git.readPackageAt(source, local)
        let remoteBranches = await this.git.listRemoteBranches(source)
        if (!headRaw && !remoteBranches.length) {
            // fresh cache — bootstrap: fetch + adopt the upstream head
            await this.fetchRefs(source).catch(() => null)
            remoteBranches = await this.git.listRemoteBranches(source)
            if (remoteBranches.includes(source.branch)) {
                await this.mergeInto(source, `origin/${source.branch}`).catch(() => null)
                headRaw = await this.git.readPackageAt(source, local)
            }
        }
        const headPackage = headRaw ? this.parsePackage(headRaw.content, 'local branch head') : null
        const aheadBehind = await this.git.aheadBehind(source)
        remoteBranches = await this.git.listRemoteBranches(source)
        const history = await this.git.history(source)
        const configDiff = this.diffAgainstHead(source, headPackage)
        return {
            localBranch: local,
            localBranches: await this.git.listLocalBranches(source),
            remoteBranches,
            ahead: aheadBehind.ahead,
            behind: aheadBehind.behind,
            headPackage,
            history,
            configDiff,
        }
    }

    /** Sections whose value in the live config differs from the branch head
     *  package (empty = nothing to commit / nothing to apply). */
    diffAgainstHead (source: SyncSource, headPackage: ConfigPackage | null): string[] {
        const current = this.currentPackage(source)
        const headModules = headPackage?.modules ?? {}
        const changed: string[] = []
        for (const section of new Set([...Object.keys(current.modules ?? {}), ...Object.keys(headModules)])) {
            if (JSON.stringify((current.modules ?? {})[section]) !== JSON.stringify(headModules[section])) {
                changed.push(section)
            }
        }
        return changed.sort()
    }

    /** Snapshot the current config onto the local branch. */
    async commitFromConfig (source: SyncSource, message: string): Promise<{ oid: string, sections: number }> {
        const pkg = this.currentPackage(source)
        const head = await this.git.branchHeadOid(source, this.git.localBranchOf(source))
        const oid = await this.git.commitPackage(
            source,
            JSON.stringify(pkg, null, 2) + '\n',
            message,
            head ? [head] : [],
        )
        this.syncLog.success('commit', `committed ${Object.keys(pkg.modules ?? {}).length} sections (${oid.slice(0, 8)})`, message.split('\n')[0])
        return { oid, sections: Object.keys(pkg.modules ?? {}).length }
    }

    /** Fetch all remote heads (updates ahead/behind and merge targets). */
    async fetchRefs (source: SyncSource): Promise<string[]> {
        const token = await this.getToken(source)
        return this.git.fetchAll(source, token)
    }

    /** Three-way merge of `fromRef` into the current local branch.
     *  Clean merge → merge commit right away; conflicts → MergeUiDraft for
     *  the UI to resolve (resolveMerge commits). */
    async mergeInto (source: SyncSource, fromRef: string): Promise<MergeUiDraft | { committed: true, oid: string }> {
        const local = this.git.localBranchOf(source)
        const oursOid = await this.git.branchHeadOid(source, local)
        const theirsRaw = await this.git.readPackageAt(source, fromRef)
        if (!theirsRaw) {
            throw new Error(`no package at ${fromRef} (branch missing or file not committed)`)
        }
        const theirs = this.parsePackage(theirsRaw.content, fromRef)

        if (!oursOid) {
            // unborn local branch: adopt theirs wholesale as the first commit
            const oid = await this.git.commitPackage(
                source, theirsRaw.content, `Adopt ${fromRef} into ${local}`, [theirsRaw.commitOid])
            this.syncLog.success('merge', `adopted ${fromRef} into ${local} (${oid.slice(0, 8)})`)
            return { committed: true, oid }
        }

        const baseOid = await this.git.mergeBase(source, oursOid, theirsRaw.commitOid)
        const baseRaw = baseOid ? await this.git.readPackageAt(source, baseOid) : null
        const base = baseRaw ? this.parsePackage(baseRaw.content, 'merge base') : null
        const oursRaw = await this.git.readPackageAt(source, local)
        const ours = this.parsePackage(oursRaw?.content ?? '{}', 'local branch head')

        const outcome = this.mergeSvc.merge(ours, theirs, base)
        if (!outcome.conflicts.length) {
            const oid = await this.git.commitPackage(
                source,
                JSON.stringify(outcome.merged, null, 2) + '\n',
                `Merge ${fromRef} into ${local}`,
                [oursOid, theirsRaw.commitOid],
            )
            const s = outcome.stats
            this.syncLog.success('merge', `merged ${fromRef} into ${local} (${oid.slice(0, 8)})`,
                `ours ${s.tookOurs}, theirs ${s.tookTheirs}, deep ${s.deepMerged}, id-union ${s.idUnioned}`)
            return { committed: true, oid }
        }
        this.syncLog.info('merge', `merge of ${fromRef} needs ${outcome.conflicts.length} resolution(s)`,
            outcome.conflicts.map(c => `${c.section}: ours=${JSON.stringify(c.ours)?.slice(0, 80)} theirs=${JSON.stringify(c.theirs)?.slice(0, 80)}`).join('\n')
            + (base ? `\n(base: ${Object.keys(base.modules ?? {}).join(', ')})` : '\n(no base)'))
        return {
            merged: outcome.merged,
            conflicts: outcome.conflicts,
            stats: outcome.stats,
            oursOid,
            theirsOid: theirsRaw.commitOid,
            fromRef,
            baseMissing: !base,
        }
    }

    /** Apply the user's per-section choices and write the merge commit. */
    async resolveMerge (source: SyncSource, draft: MergeUiDraft, choices: Record<string, 'ours' | 'theirs'>): Promise<{ oid: string }> {
        const local = this.git.localBranchOf(source)
        for (const [section, side] of Object.entries(choices)) {
            this.mergeSvc.resolveSection(draft, section, side)
        }
        if (draft.conflicts.length) {
            throw new Error(`unresolved sections: ${draft.conflicts.map(c => c.section).join(', ')}`)
        }
        const oid = await this.git.commitPackage(
            source,
            JSON.stringify(draft.merged, null, 2) + '\n',
            `Merge ${draft.fromRef} into ${local}`,
            [draft.oursOid, draft.theirsOid],
        )
        this.syncLog.success('merge', `merge committed (${oid.slice(0, 8)}) after conflict resolution`)
        return { oid }
    }

    /** Apply the local branch head package onto the live config. */
    async applyToConfig (source: SyncSource, mode: 'merge' | 'replace'): Promise<ApplyResult> {
        const local = this.git.localBranchOf(source)
        const headRaw = await this.git.readPackageAt(source, local)
        if (!headRaw) {
            throw new Error(`local branch "${local}" has no package to apply`)
        }
        const pkg = this.parsePackage(headRaw.content, local)
        const report = this.io.validatePackage(pkg)
        if (!report.ok) {
            throw new Error(`package at ${local} failed validation: ${report.issues.map(i => i.message).join('; ')}`)
        }
        const result = await this.io.applyPackage(pkg, { mode, keys: null })
        this.syncLog.success('apply', `applied ${local} to config (${mode})`,
            Object.keys(pkg.modules ?? {}).join(', '))
        // stamp lastPull in a single read-modify-write
        const raw = this.map.rawStore()
        const stored = (raw?.betterConfiger?.sync?.sources ?? []).find((s: SyncSource) => s.id === source.id)
        if (stored) {
            stored.lastPull = { at: new Date().toISOString(), oid: headRaw.commitOid, message: headRaw.message }
            await this.config.writeRaw(yaml.dump(raw))
        }
        return result
    }

    /** Push the local branch onto the upstream remote branch. */
    async pushWorkspace (source: SyncSource, force = false): Promise<{ oid: string, ahead: number }> {
        const token = await this.getToken(source)
        const oid = await this.git.pushBranch(source, token, force)
        const raw = this.map.rawStore()
        const stored = (raw?.betterConfiger?.sync?.sources ?? []).find((s: SyncSource) => s.id === source.id)
        if (stored) {
            stored.lastPush = { at: new Date().toISOString(), oid }
            await this.config.writeRaw(yaml.dump(raw))
        }
        return { oid, ahead: 0 }
    }

    /** One-click: fetch → merge origin/upstream → apply to config.
     *  Conflicts abort with a pointer to the explicit Merge flow. */
    async updateAndApply (source: SyncSource): Promise<ApplyResult | null> {
        await this.fetchRefs(source)
        const outcome = await this.mergeInto(source, `origin/${source.branch}`)
        if ('conflicts' in outcome && outcome.conflicts?.length) {
            throw new Error(`merge from origin/${source.branch} has conflicts — resolve them via Merge`)
        }
        return this.applyToConfig(source, 'merge')
    }

    // ------------------------------------------------------------ branches ----

    async createBranch (source: SyncSource, name: string, fromRef?: string): Promise<void> {
        await this.git.createBranch(source, name, fromRef)
    }

    async switchBranch (source: SyncSource, name: string): Promise<void> {
        const raw = this.map.rawStore()
        const stored = (raw?.betterConfiger?.sync?.sources ?? []).find((s: SyncSource) => s.id === source.id)
        if (stored) {
            stored.localBranch = name
            await this.config.writeRaw(yaml.dump(raw))
        }
        await this.git.switchBranch({ ...source, localBranch: name }, name)
    }

    async deleteBranch (source: SyncSource, name: string): Promise<void> {
        await this.git.deleteBranch(source, name)
    }

    async listServerBranches (source: SyncSource): Promise<string[]> {
        const token = await this.getToken(source)
        return this.git.listServerBranches(source.url, token)
    }

    // ------------------------------------------------------------- utils ----

    private parsePackage (content: string | undefined, what: string): ConfigPackage {
        if (!content) {
            throw new Error(`no package content at ${what}`)
        }
        return JSON.parse(content)
    }

    private async persistSources (sources: SyncSource[]): Promise<void> {
        const raw = this.map.rawStore()
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        raw.betterConfiger.sync.sources = sources
        await this.config.writeRaw(yaml.dump(raw))
    }
}

export { PushRejectedError }
