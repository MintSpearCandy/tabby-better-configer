import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { ConfigMapService } from './configMap.service'

const HIDER_STYLE_ID = 'better-configer-native-tabs-hider'
const LAYOUT_STYLE_ID = 'better-configer-layout-override'

/** CSS rules removing Tabby's native settings pills. Selectors verified
 *  against the v1.0.237 host markup:
 *  - `config-file` is a STATIC nav item — the ngbNavItem attribute stays in
 *    the DOM (property-bound ids do not), so an exact attribute match works.
 *  - `config-sync` is a provider-generated item with no stable attribute; its
 *    nav icon (fa-cloud) is unique within the settings nav, so :has() pins it.
 *  Both toggles are pure presentation: the underlying pages/providers keep
 *  working (in particular Tabby's own config-sync service is unaffected). */
const RULE_CONFIG_FILE = 'settings-tab ul.nav-pills li.nav-item[ngbNavItem="config-file"] { display: none !important; }'
const RULE_CONFIG_SYNC = 'settings-tab ul.nav-pills li.nav-item:has(> a .fa-cloud) { display: none !important; }'

/** Full-pane layout unlock for the BetterConfiger settings tab. Tabby's
 *  settings-tab-body is a plain auto-height, 600px-wide block: without this,
 *  our height is driven by the tallest child and overflows the pane, scrolling
 *  the whole page instead of the tab content. The :has() guard keeps the rule
 *  inert unless our component actually exists. */
const LAYOUT_OVERRIDE_CSS = [
    'settings-tab-body:has(> better-configer) {',
    '    max-width: none !important;',
    '    height: 100%;',
    '    display: flex;',
    '    flex-direction: column;',
    '    overflow: hidden;',
    '}',
].join('\n')

/**
 * Host-page style management for the plugin:
 *
 *  1. hides Tabby's native "Config file" / "Config sync" settings pills when
 *     the user opts in (toggles on the Config file & sync tab);
 *  2. unlocks the settings pane layout for our tabs.
 *
 * Injected here (not from a component) so the effects hold on every settings
 * tab while the plugin is loaded — and vanish naturally when the plugin is
 * uninstalled (styles die with the page). start() is called once from the
 * module constructor (eager instantiation).
 */
@Injectable({ providedIn: 'root' })
export class NativeTabsService {
    constructor (
        private config: ConfigService,
        private map: ConfigMapService,
    ) { }

    start (): void {
        this.injectLayoutOverride()
        this.config.ready$.subscribe(ready => {
            if (ready) {
                this.refresh()
            }
        })
        this.config.changed$.subscribe(() => this.refresh())
    }

    private refresh (): void {
        try {
            const raw = this.map.rawStore().betterConfiger ?? {}
            const rules: string[] = []
            if (raw['hideNativeConfigFileTab'] === true) {
                rules.push(RULE_CONFIG_FILE)
            }
            if (raw['hideNativeConfigSyncTab'] === true) {
                rules.push(RULE_CONFIG_SYNC)
            }
            let style = document.getElementById(HIDER_STYLE_ID)
            if (!rules.length) {
                style?.remove()
                return
            }
            if (!style) {
                style = document.createElement('style')
                style.id = HIDER_STYLE_ID
                document.head.appendChild(style)
            }
            style.textContent = rules.join('\n')
        } catch {
            // non-fatal: native tabs simply stay visible
        }
    }

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
