import { Injectable } from '@angular/core'
import { ConfigService, VaultService } from 'tabby-core'
import * as crypto from 'crypto'
import * as yaml from 'js-yaml'

import { ConfigMapService } from './configMap.service'
import { PackageIOService, ConfigPackage, ValidationReport, ApplyResult } from './packageIO.service'
import { GitSyncService, GitSyncTarget, RemoteFile, PushRejectedError } from './gitSync.service'
import { SyncLogService } from './syncLog.service'

export const VAULT_TOKEN_TYPE = 'better-configer-git-token'

/** One git sync source = repo + branch + package file + apply mode.
 *  Persisted under `betterConfiger.sync.sources` in config.yaml — EXCEPT the
 *  token, which goes to the Tabby vault when available (tokenPlain is the
 *  plaintext fallback for vault-less setups). */
export interface SyncSource extends GitSyncTarget {
    name: string
    mode: 'merge' | 'replace'
    /** push: include vault/encrypted/configSync sections in the package */
    includeSensitive: boolean
    /** set when the token was stored in the vault (informational) */
    tokenInVault?: boolean
    tokenPlain?: string
    lastPull?: { at: string, oid: string, message: string }
    lastPush?: { at: string, oid: string }
}

export interface PullPreview {
    pkg: ConfigPackage
    report: ValidationReport
    remote: RemoteFile
}

/** Sections never pushed: plugin-self configuration (toggles, source list,
 *  token fallbacks) is machine-local by design. */
const NEVER_PUSH_KEYS = ['version', 'betterConfiger']

/**
 * Orchestrates git config sync: source CRUD, token storage (vault-first),
 * and pull/push built on PackageIOService's existing package semantics
 * (validate → confirm → apply with merge/replace + id-union for arrays).
 */
@Injectable({ providedIn: 'root' })
export class SyncSourcesService {
    constructor (
        private config: ConfigService,
        private map: ConfigMapService,
        private io: PackageIOService,
        private git: GitSyncService,
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

    async setLogDebug (value: boolean): Promise<void> {
        const raw = this.map.rawStore()
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        raw.betterConfiger.sync.logDebug = value
        await this.config.writeRaw(yaml.dump(raw))
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

    async saveSource (src: SyncSource): Promise<void> {
        const sources = this.sources().filter(s => s.id !== src.id)
        sources.push(src)
        await this.persist(sources)
        this.syncLog.info('source', `saved source "${src.name}"`, `${src.url} @ ${src.branch} : ${src.path} (mode: ${src.mode})`)
    }

    async deleteSource (id: string): Promise<void> {
        const src = this.sources().find(s => s.id === id)
        await this.setToken({ ...src, id } as SyncSource, null)
            .catch(() => null)
        this.git.dropCache(id)
        // single read-modify-write: re-reading inside persist() could race a
        // concurrent lastPull/lastPush write and resurrect the source
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

    // -------------------------------------------------------- operations ----

    async listBranches (source: SyncSource): Promise<string[]> {
        const token = await this.getToken(source)
        return this.git.listBranches(source.url, token)
    }

    /** Fetch + read + validate, WITHOUT applying anything (confirm step). */
    async previewPull (source: SyncSource): Promise<PullPreview> {
        const token = await this.getToken(source)
        const remote = await this.git.readFile(source, token)
        let pkg: ConfigPackage
        try {
            pkg = JSON.parse(remote.content)
        } catch (e: any) {
            throw new Error(`${source.path} on ${source.branch} is not valid JSON: ${e?.message ?? e}`)
        }
        const report = this.io.validatePackage(pkg)
        this.syncLog.info('pull', `validated package from "${source.name}" (${report.issues.length} notes)`,
            report.issues.map(i => `[${i.level}] ${i.message}`).join('\n') || undefined)
        return { pkg, report, remote }
    }

    async applyPull (source: SyncSource, preview: PullPreview, mode: 'merge' | 'replace'): Promise<ApplyResult> {
        const result = await this.io.applyPackage(preview.pkg, { mode, keys: null })
        const stats = result.profilesStats
            ? ` — profiles: +${result.profilesStats.added}, ~${result.profilesStats.overwritten}` : ''
        this.syncLog.success('pull', `applied package (${mode})${stats}`,
            Object.keys(preview.pkg.modules ?? {}).join(', '))
        // stamp lastPull on a FRESH read of the store: the package apply just
        // rewrote it wholesale, and any older snapshot would resurrect
        // concurrently-deleted sources (lost update)
        const sources = this.sources()
        const stored = sources.find(s => s.id === source.id)
        if (stored) {
            stored.lastPull = {
                at: new Date().toISOString(),
                oid: preview.remote.oid,
                message: preview.remote.message,
            }
            await this.persist(sources)
        }
        return result
    }

    /** Package the current config for pushing (sections list is informational). */
    buildPushPayload (source: SyncSource): { json: string, sections: string[], excluded: string[] } {
        const raw = this.map.rawStore()
        const keys = Object.keys(raw).filter(k => !NEVER_PUSH_KEYS.includes(k))
        const excluded = source.includeSensitive
            ? []
            : keys.filter(k => ['vault', 'encrypted', 'configSync'].includes(k))
        const sections = keys.filter(k => !excluded.includes(k))
        const json = this.io.serializePackage('full', sections, source.includeSensitive)
        return { json, sections, excluded }
    }

    async push (source: SyncSource, force = false): Promise<{ oid: string, sections: number }> {
        const { json, sections } = this.buildPushPayload(source)
        const token = await this.getToken(source)
        const message = `BetterConfiger: update config package (${sections.length} sections)\n\nPushed from Tabby at ${new Date().toISOString()}`
        const { oid } = await this.git.writeFile(source, json, message, token, force)
        if (force) {
            this.syncLog.success('push', `force-pushed ${sections.length} sections (${oid.slice(0, 8)})`)
        }
        // one read, one write — persist(this.sources()) would re-read the
        // store from disk and silently drop the lastPush just set
        const sources = this.sources()
        const stored = sources.find(s => s.id === source.id)
        if (stored) {
            stored.lastPush = { at: new Date().toISOString(), oid }
            await this.persist(sources)
        }
        return { oid, sections: sections.length }
    }

    /** Like push(), but never applies a force flag — used to surface
     *  PushRejectedError to the caller for an explicit overwrite choice. */
    async pushIfFastForward (source: SyncSource): Promise<{ oid: string, sections: number }> {
        return this.push(source, false)
    }

    async pushForce (source: SyncSource): Promise<{ oid: string, sections: number }> {
        return this.push(source, true)
    }

    private async persist (sources: SyncSource[]): Promise<void> {
        const raw = this.map.rawStore()
        raw.betterConfiger = raw.betterConfiger ?? {}
        raw.betterConfiger.sync = raw.betterConfiger.sync ?? {}
        raw.betterConfiger.sync.sources = sources
        await this.config.writeRaw(yaml.dump(raw))
    }
}

export { PushRejectedError }
