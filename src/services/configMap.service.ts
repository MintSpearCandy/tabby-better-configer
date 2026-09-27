import { Injectable, Inject } from '@angular/core'
import { ConfigProvider, ConfigService, HostAppService, configMerge } from 'tabby-core'
import * as yaml from 'js-yaml'

import { BetterConfigerTranslator } from '../i18n'

/** Sections that hold secrets / encryption flags / sync credentials. They are
 *  flagged in the UI and excluded from exports unless explicitly confirmed. */
export const SENSITIVE_KEYS = ['vault', 'encrypted', 'configSync']

/** Array sections that are merged by `id` instead of wholesale replacement. */
export const ID_MERGED_KEYS = ['profiles', 'groups']

export interface KeyInfo {
    key: string
    /** plugin names (npm package names) whose ConfigProvider declares this key */
    declarers: string[]
    /** declared by at least one installed ConfigProvider */
    known: boolean
    sensitive: boolean
    /** present in config.yaml but not declared by any provider (leftover etc.) */
    orphan: boolean
}

export interface PluginGroup {
    pluginName: string
    displayName: string
    builtin: boolean
    order: number
    keys: KeyInfo[]
    expanded?: boolean
}

/** Builtin plugins: nav ordering, keyed by the SHORT plugin name that Tabby's
 *  loader assigns (module.pluginName = 'core', 'terminal', ... — verified via
 *  window.pluginModules; NOT the npm package name 'tabby-core'). */
const BUILTIN_PLUGINS: Record<string, number> = {
    'core': 1,
    'terminal': 2,
    'ssh': 3,
    'settings': 4,
    'local': 5,
    'serial': 6,
    'telnet': 7,
    'linkifier': 8,
    'electron': 9,
}

const OTHER_GROUP = '(unknown)'
const ORDER_THIRD_PARTY = 100
const ORDER_OTHER = 1000

/** Providers not attributable via pluginModules: tabby-core's module is
 *  imported directly by the host AppModule and never goes through the plugin
 *  loader, so it has no entry in window['pluginModules']. Verified live:
 *  CoreConfigProvider is the only such case; fall back to class names. */
const PROVIDER_FALLBACK_BY_CLASS: Record<string, string> = {
    'CoreConfigProvider': 'core',
}

/** Internal bookkeeping keys that should not be shown or exported. */
const HIDDEN_KEYS = ['version']

/**
 * Builds the two-level map shown in the Config Manager nav:
 * plugin group → top-level config keys declared by that plugin's ConfigProviders.
 *
 * Provider→plugin attribution reuses the same mechanism as
 * ConfigService.enabledServices (window['pluginModules'] + module.ɵinj.providers)
 * but WITHOUT its blacklist filtering — we want pure attribution, so that
 * blacklisted/unloaded plugin leftovers correctly land in the "Other" group
 * instead of silently disappearing.
 */
@Injectable({ providedIn: 'root' })
export class ConfigMapService {
    private ctorCache: Record<string, Function[]> | null = null

    constructor (
        @Inject(ConfigProvider) private configProviders: ConfigProvider[],
        private config: ConfigService,
        private hostApp: HostAppService,
        private t: BetterConfigerTranslator,
    ) { }

    /** The raw persisted store (only what the user actually set). Reading this
     *  (instead of config.store) avoids ConfigProxy's side effect of freezing
     *  array/__nonStructural defaults into the persisted store. */
    rawStore (): Record<string, any> {
        return yaml.load(this.config.readRaw()) ?? {}
    }

    defaultsForKey (key: string): any {
        return (this.config.getDefaults() as Record<string, any>)?.[key]
    }

    /** All top-level keys that some installed ConfigProvider declares. */
    declaredKeys (): Set<string> {
        const keys = new Set<string>()
        for (const p of this.configProviders) {
            for (const k of this.providerTopLevelKeys(p)) {
                keys.add(k)
            }
        }
        return keys
    }

    buildGroups (): PluginGroup[] {
        const cache = this.ctorCacheOf()
        const declarers = new Map<string, string[]>()
        const pluginKeys = new Map<string, Set<string>>()
        for (const p of this.configProviders) {
            const pluginName = this.pluginForProvider(p, cache)
                ?? PROVIDER_FALLBACK_BY_CLASS[p.constructor?.name]
            if (!pluginName) {
                continue
            }
            for (const key of this.providerTopLevelKeys(p)) {
                const d = declarers.get(key) ?? []
                if (!d.includes(pluginName)) {
                    d.push(pluginName)
                }
                declarers.set(key, d)
                const set = pluginKeys.get(pluginName) ?? new Set()
                set.add(key)
                pluginKeys.set(pluginName, set)
            }
        }

        const groups: PluginGroup[] = []
        for (const [pluginName, keys] of pluginKeys) {
            const builtinOrder = BUILTIN_PLUGINS[pluginName]
            groups.push({
                pluginName,
                displayName: this.displayNameFor(pluginName),
                builtin: builtinOrder !== undefined,
                order: builtinOrder ?? ORDER_THIRD_PARTY,
                keys: [...keys].sort().map(key => ({
                    key,
                    declarers: declarers.get(key) ?? [],
                    known: true,
                    sensitive: SENSITIVE_KEYS.includes(key),
                    orphan: false,
                })),
            })
        }

        // Keys present in config.yaml but not declared by any provider
        const declared = new Set(declarers.keys())
        const raw = this.rawStore()
        const orphans = Object.keys(raw)
            .filter(k => !declared.has(k) && !HIDDEN_KEYS.includes(k))
            .sort()
        if (orphans.length) {
            groups.push({
                pluginName: OTHER_GROUP,
                displayName: this.t.t('betterConfiger.nav.other'),
                builtin: false,
                order: ORDER_OTHER,
                keys: orphans.map(key => ({
                    key,
                    declarers: [],
                    known: false,
                    sensitive: SENSITIVE_KEYS.includes(key),
                    orphan: true,
                })),
            })
        }

        return groups.sort((a, b) =>
            a.order - b.order || a.displayName.localeCompare(b.displayName))
    }

    pluginDisplayName (pluginName: string): string {
        return this.displayNameFor(pluginName)
    }

    private displayNameFor (pluginName: string): string {
        if (BUILTIN_PLUGINS[pluginName] !== undefined) {
            return this.t.t(`betterConfiger.plugin.${pluginName}`)
        }
        return pluginName
    }

    /** Top-level keys of one provider, merged the same way
     *  ConfigService.mergeDefaults() does (platform overrides configPlatform
     *  overrides defaults — irrelevant for the key set, but kept identical). */
    private providerTopLevelKeys (p: ConfigProvider): string[] {
        let defaults = p.platformDefaults?.[this.hostApp.configPlatform] ?? {}
        defaults = configMerge(defaults, p.platformDefaults?.[this.hostApp.platform] ?? {})
        if (p.defaults) {
            defaults = configMerge(p.defaults, defaults)
        }
        return Object.keys(defaults ?? {}).filter(k => !HIDDEN_KEYS.includes(k))
    }

    /** Mirror of enabledServices' attribution cache (config.service.ts):
     * pluginName → list of provider classes declared in that plugin's NgModule. */
    private ctorCacheOf (): Record<string, Function[]> {
        if (!this.ctorCache) {
            this.ctorCache = {}
            for (const imp of (window as any).pluginModules ?? []) {
                const module = imp.ngModule || imp
                if (module.ɵinj?.providers) {
                    this.ctorCache[module.pluginName] = module.ɵinj.providers.map(
                        (provider: any) => provider.useClass ?? provider.useExisting ?? provider)
                }
            }
        }
        return this.ctorCache
    }

    private pluginForProvider (p: ConfigProvider, cache: Record<string, Function[]>): string | null {
        for (const pluginName in cache) {
            if (cache[pluginName].includes(p.constructor)) {
                return pluginName
            }
        }
        return null
    }
}
