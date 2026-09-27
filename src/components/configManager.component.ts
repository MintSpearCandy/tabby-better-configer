import { Component, OnInit, OnDestroy } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService, NotificationsService } from 'tabby-core'

import { KeyInfo, PluginGroup, ConfigMapService } from '../services/configMap.service'
import { PackageIOService, ConfigPackage } from '../services/packageIO.service'
import { ModuleContentRegistry } from '../services/moduleContent.registry'
import { BetterConfigerTranslator } from '../i18n'

/** Layout unlock, injected while this component exists (the :has() guard
 *  keeps it inert on all other settings tabs). Tabby's settings-tab-body is
 *  a plain auto-height block: without this, OUR height is driven by the
 *  tallest child (the left nav, fully expanded) and overflows the pane,
 *  scrolling the whole page instead of the nav. Locked to 100% of the pane
 *  (div.tab-pane has a definite viewport-derived height), the nav scrolls
 *  internally and the editor fills the remaining space. */
const LAYOUT_OVERRIDE_CSS = [
    'settings-tab-body:has(> better-configer) {',
    '    max-width: none !important;',
    '    height: 100%;',
    '    display: flex;',
    '    flex-direction: column;',
    '    overflow: hidden;',
    '}',
].join('\n')
const LAYOUT_STYLE_ID = 'better-configer-layout-override'

@Component({
    selector: 'better-configer',
    template: require('./configManager.component.pug'),
    styles: [require('./configManager.component.scss')],
})
export class ConfigManagerComponent extends BaseComponent implements OnInit, OnDestroy {
    groups: PluginGroup[] = []
    selectedKey: string | null = null
    selectedKeyInfo: KeyInfo | null = null
    importing = false

    constructor (
        public config: ConfigService,
        private map: ConfigMapService,
        private registry: ModuleContentRegistry,
        private io: PackageIOService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        public t: BetterConfigerTranslator,
    ) {
        super()
    }

    ngOnInit (): void {
        this.injectLayoutOverride()
        this.rebuildGroups()
        // Select the first section so the pane is never empty on open
        const first = this.groups[0]?.keys[0]
        if (first) {
            this.selectKey(first.key)
        }
        // Sections can appear (import) or disappear (delete) after every save
        this.subscribeUntilDestroyed(this.config.changed$, () => this.rebuildGroups());
        // Re-render when the host language changes (t() reads the locale live)
        this.subscribeUntilDestroyed(this.t.localeChanged$, () => this.rebuildGroups());
        // Debug handles for the CDP-driven verification workflow (harmless in
        // production; they just expose the two services on window).
        (window as any).__betterConfigerMap = this.map;
        (window as any).__betterConfigerIO = this.io;
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        // The width override style element is intentionally left in place:
        // the :has() selector only matches while a <better-configer> element
        // exists, so it is inert on all other settings tabs.
    }

    rebuildGroups (): void {
        const prevExpanded = new Map(this.groups.map(g => [g.pluginName, g.expanded]))
        const prevSelected = this.selectedKey
        this.groups = this.map.buildGroups()
        for (const g of this.groups) {
            g.expanded = prevExpanded.get(g.pluginName) ?? (g === this.groups[0])
        }
        // keep selection valid across rebuilds
        const stillThere = this.groups.some(g => g.keys.some(k => k.key === prevSelected))
        if (prevSelected && stillThere) {
            this.selectKey(prevSelected)
        } else if (!this.selectedKey || !stillThere) {
            this.selectedKey = null
            this.selectedKeyInfo = null
        }
    }

    toggleGroup (group: PluginGroup): void {
        group.expanded = !group.expanded
    }

    selectKey (key: string): void {
        this.selectedKey = key
        this.selectedKeyInfo = this.findKeyInfo(key)
    }

    /** v2: custom component for this key (structured profiles form). Null in
     *  v1 → the generic YAML editor is used. */
    customComponentFor (key: string): any | null {
        return this.registry.getComponentType(key)
    }

    async importPackage (): Promise<void> {
        if (this.importing) {
            return
        }
        this.importing = true
        try {
            let pkg: ConfigPackage | null
            try {
                pkg = await this.io.pickAndReadPackage()
            } catch (e: any) {
                this.notifications.error(`${this.t.t('betterConfiger.import.badJson')}: ${e?.message ?? e}`)
                return
            }
            if (!pkg) {
                return
            }
            const report = this.io.validatePackage(pkg)
            if (!report.ok) {
                this.notifications.error(this.t.t('betterConfiger.import.notAPackage'))
                return
            }
            const t = this.t
            const detailLines = [
                `${t.t('betterConfiger.title')}: ${Object.keys(pkg.modules ?? {}).join(', ') || '(empty)'}`,
                '',
                ...report.issues.map(i => `[${i.level}] ${i.message}`),
            ]
            const r = await this.platform.showMessageBox({
                type: 'warning',
                buttons: [
                    t.t('betterConfiger.import.mergeButton'),
                    t.t('betterConfiger.import.replaceButton'),
                    t.t('betterConfiger.editor.cancel'),
                ],
                defaultId: 0,
                cancelId: 2,
                message: t.t('betterConfiger.import.title'),
                detail: detailLines.join('\n'),
            })
            if (r.response === 2) {
                this.notifications.info(t.t('betterConfiger.import.cancelled'))
                return
            }
            const result = await this.io.applyPackage(pkg, {
                mode: r.response === 0 ? 'merge' : 'replace',
                keys: null,
            })
            const stats = result.profilesStats
                ? ` (profiles: +${result.profilesStats.added}, ~${result.profilesStats.overwritten})`
                : ''
            this.notifications.info(`${t.t('betterConfiger.import.applied')}${stats}`)
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.import.failed')}: ${e?.message ?? e}`)
        } finally {
            this.importing = false
        }
    }

    async exportAll (): Promise<void> {
        try {
            // full export always excludes sensitive sections; those can be
            // exported individually from their editor with a confirmation
            const keys = Object.keys(this.map.rawStore()).filter(k => k !== 'version')
            await this.io.exportToFile('full', keys, false)
            this.notifications.info(this.t.t('betterConfiger.export.done'))
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.export.failed')}: ${e?.message ?? e}`)
        }
    }

    private findKeyInfo (key: string): KeyInfo | null {
        for (const g of this.groups) {
            const ki = g.keys.find(k => k.key === key)
            if (ki) {
                return ki
            }
        }
        return null
    }

    /** Tabby's settings-tab-body is an auto-height, 600px-wide block. While
     *  this component exists, pin it to the pane height and full width via a
     *  :has() rule (Chromium 120+); on failure the layout degrades to the
     *  stock host behavior. The style element is intentionally left in place:
     *  the :has() selector only matches while a <better-configer> element
     *  exists, so it is inert on all other settings tabs. */
    private injectLayoutOverride (): void {
        try {
            if (document.getElementById(LAYOUT_STYLE_ID)) {
                return
            }
            const style = document.createElement('style')
            style.id = LAYOUT_STYLE_ID
            style.textContent = LAYOUT_OVERRIDE_CSS
            document.head.appendChild(style)
        } catch {
            // non-fatal: fall back to host layout
        }
    }
}
