import { Injectable } from '@angular/core'
import { ConfigService, PlatformService, configMerge } from 'tabby-core'
import { app } from '@electron/remote'
import * as yaml from 'js-yaml'

import { ConfigMapService, SENSITIVE_KEYS, ID_MERGED_KEYS } from './configMap.service'

export const PACKAGE_FORMAT = 'tabby-config-package'
export const PACKAGE_SCHEMA_VERSION = 1

export interface ConfigPackage {
    format: string
    version: number
    kind: 'module' | 'full'
    exportedAt: string
    tabbyVersion: string
    /** top-level key → raw persisted subtree (only explicit values, no defaults) */
    modules: Record<string, any>
    /** sections that were excluded at export time (informational) */
    excluded: string[]
}

export interface ValidationIssue {
    level: 'error' | 'warning' | 'info'
    message: string
}

export interface ValidationReport {
    ok: boolean
    issues: ValidationIssue[]
    sensitiveKeys: string[]
    unknownKeys: string[]
    profilesStats: { added: number; overwritten: number } | null
}

export interface ApplyResult {
    profilesStats: { added: number; overwritten: number } | null
}

export interface ApplyOptions {
    /** merge: deep-merge objects (arrays replaced by the imported one);
     *  replace: imported subtree wins wholesale. profiles/groups always
     *  merge by id regardless of mode. */
    mode: 'merge' | 'replace'
    /** null = all modules present in the package */
    keys: string[] | null
}

/**
 * Import/export of config sections as a self-describing JSON package.
 *
 * All writes go through a single ConfigService.writeRaw() call (raw
 * read-modify-write on the persisted store) — never through the ConfigProxy
 * (`config.store.<key> = ...`), because structural top-level keys are
 * getter-only on the proxy and unknown-key assignments are silently dropped
 * at save time.
 */
@Injectable({ providedIn: 'root' })
export class PackageIOService {
    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private map: ConfigMapService,
    ) { }

    appVersion (): string {
        try {
            return app.getVersion()
        } catch {
            return ''
        }
    }

    /** Build a package from the current raw store. */
    serializePackage (kind: 'module' | 'full', keys: string[], includeSensitive: boolean): string {
        const raw = this.map.rawStore()
        const excluded: string[] = []
        const modules: Record<string, any> = {}
        const wanted = new Set(keys)
        for (const key of Object.keys(raw)) {
            if (key === 'version') {
                continue
            }
            if (!wanted.has(key)) {
                continue
            }
            if (SENSITIVE_KEYS.includes(key) && !includeSensitive) {
                excluded.push(key)
                continue
            }
            modules[key] = raw[key]
        }
        if (!includeSensitive) {
            for (const key of SENSITIVE_KEYS) {
                if (wanted.has(key) && !excluded.includes(key)) {
                    excluded.push(key)
                }
            }
        }
        const pkg: ConfigPackage = {
            format: PACKAGE_FORMAT,
            version: PACKAGE_SCHEMA_VERSION,
            kind,
            exportedAt: new Date().toISOString(),
            tabbyVersion: this.appVersion(),
            modules,
            excluded,
        }
        return JSON.stringify(pkg, null, 2) + '\n'
    }

    async exportToFile (kind: 'module' | 'full', keys: string[], includeSensitive: boolean): Promise<void> {
        const json = this.serializePackage(kind, keys, includeSensitive)
        const stamp = this.timestamp()
        const scope = kind === 'full' ? 'full' : keys.length === 1 ? keys[0] : 'modules'
        const filename = `tabby-config-${scope}-${stamp}.tabby-config.json`
        const bytes = Buffer.from(json, 'utf8')
        const download = await this.platform.startDownload(filename, 0o644, bytes.length)
        try {
            await download.write(bytes)
        } finally {
            await download.close()
        }
    }

    /** File picker → parsed package, or null if the user cancelled. Throws on
     *  unreadable content; caller catches and surfaces the error. */
    async pickAndReadPackage (): Promise<ConfigPackage | null> {
        const [upload] = await this.platform.startUpload({ multiple: false })
        if (!upload) {
            return null
        }
        const buf = await upload.readAll()
        if (!buf) {
            return null
        }
        return JSON.parse(new TextDecoder().decode(buf))
    }

    validatePackage (pkg: ConfigPackage): ValidationReport {
        const issues: ValidationIssue[] = []
        const sensitiveKeys: string[] = []
        const unknownKeys: string[] = []
        let profilesStats: { added: number; overwritten: number } | null = null

        if (pkg?.format !== PACKAGE_FORMAT) {
            issues.push({ level: 'error', message: 'unrecognized format' })
            return { ok: false, issues, sensitiveKeys, unknownKeys, profilesStats }
        }
        if ((pkg.version ?? 0) > PACKAGE_SCHEMA_VERSION) {
            issues.push({ level: 'warning', message: `package schema v${pkg.version} is newer than supported v${PACKAGE_SCHEMA_VERSION}; unknown fields will be ignored` })
        }

        const declared = this.map.declaredKeys()
        for (const key of Object.keys(pkg.modules ?? {})) {
            if (!declared.has(key)) {
                unknownKeys.push(key)
            }
            if (SENSITIVE_KEYS.includes(key)) {
                sensitiveKeys.push(key)
            }
        }
        if (unknownKeys.length) {
            issues.push({ level: 'info', message: `no installed plugin declares: ${unknownKeys.join(', ')} (will land in "Other")` })
        }
        if (sensitiveKeys.length) {
            issues.push({ level: 'warning', message: `contains sensitive sections: ${sensitiveKeys.join(', ')}` })
        }

        const pkgVersion = pkg.tabbyVersion ?? ''
        const mine = this.appVersion()
        if (pkgVersion && mine) {
            const scope = (v: string) => v.split('.').slice(0, 2).join('.')
            if (scope(pkgVersion) !== scope(mine)) {
                issues.push({ level: 'warning', message: `exported from Tabby ${pkgVersion}, this is ${mine}; key structure may differ` })
            }
        }

        if (pkg.modules?.profiles !== undefined) {
            const current = this.map.rawStore().profiles
            if (Array.isArray(current) && Array.isArray(pkg.modules.profiles)) {
                profilesStats = this.statsByIdMerge(current, pkg.modules.profiles)
                issues.push({ level: 'info', message: `profiles: ${profilesStats.added} new, ${profilesStats.overwritten} overwritten` })
            }
        }

        return {
            ok: !issues.some(i => i.level === 'error'),
            issues,
            sensitiveKeys,
            unknownKeys,
            profilesStats,
        }
    }

    /** Apply a package: compute the new full raw store in memory, then a
     *  single writeRaw() (one save / one changed$ broadcast, no intermediate
     *  states). The local `version` key is never touched (dropped at export). */
    async applyPackage (pkg: ConfigPackage, opts: ApplyOptions): Promise<ApplyResult> {
        const raw = this.map.rawStore()
        const keys = opts.keys ?? Object.keys(pkg.modules ?? {})
        const wanted = new Set(keys)
        let profilesStats: { added: number; overwritten: number } | null = null

        for (const key of wanted) {
            const imported = pkg.modules[key]
            if (imported === undefined) {
                continue
            }
            if (ID_MERGED_KEYS.includes(key) && Array.isArray(raw[key]) && Array.isArray(imported)) {
                const merged = this.mergeByIdArrays(raw[key] as any[], imported as any[])
                profilesStats = profilesStats
                    ? { added: profilesStats.added + merged.added, overwritten: profilesStats.overwritten + merged.overwritten }
                    : { added: merged.added, overwritten: merged.overwritten }
                raw[key] = merged.merged
            } else if (opts.mode === 'merge' && isPlainObject(raw[key]) && isPlainObject(imported)) {
                raw[key] = configMerge(raw[key], imported)
            } else if (imported === null) {
                delete raw[key]
            } else {
                raw[key] = imported
            }
        }

        await this.config.writeRaw(yaml.dump(raw))
        return { profilesStats }
    }

    /** Union by `id`; imported entries overwrite same-id local ones. Throws on
     *  items without an id (they could never be referenced consistently). */
    private mergeByIdArrays (current: any[], imported: any[]): { merged: any[]; added: number; overwritten: number } {
        const byId = new Map<string, any>()
        for (const item of current) {
            byId.set(item?.id ?? JSON.stringify(item), item)
        }
        let added = 0
        let overwritten = 0
        for (const item of imported) {
            if (!item || typeof item.id !== 'string') {
                throw new Error('array item without string id')
            }
            if (byId.has(item.id)) {
                overwritten++
            } else {
                added++
            }
            byId.set(item.id, item)
        }
        return { merged: [...byId.values()], added, overwritten }
    }

    private statsByIdMerge (current: any[], imported: any[]): { added: number; overwritten: number } {
        const ids = new Set(current.map(x => x?.id ?? JSON.stringify(x)))
        let added = 0
        let overwritten = 0
        for (const item of imported) {
            if (ids.has(item?.id)) {
                overwritten++
            } else {
                added++
            }
            ids.add(item?.id)
        }
        return { added, overwritten }
    }

    private timestamp (): string {
        const d = new Date()
        const p = (n: number, w = 2) => String(n).padStart(w, '0')
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    }
}

function isPlainObject (v: any): v is Record<string, any> {
    return v instanceof Object && !(v instanceof Array)
}
