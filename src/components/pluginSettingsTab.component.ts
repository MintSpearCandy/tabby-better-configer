import { Component, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'tabby-core'
import * as yaml from 'js-yaml'

import { ConfigMapService } from '../services/configMap.service'
import { BetterConfigerTranslator } from '../i18n'

/**
 * The Settings sub-tab of the Config Manager: plugin-level options.
 * Currently the native settings-page toggles (hide Tabby's own
 * "Config file" / "Config sync" pills — this plugin replaces both).
 */
@Component({
    selector: 'bc-plugin-settings',
    template: require('./pluginSettingsTab.component.pug'),
    styles: [require('./pluginSettingsTab.component.scss')],
})
export class PluginSettingsTabComponent extends BaseComponent implements OnInit {
    hideNativeConfigFile = false
    hideNativeConfigSync = false

    constructor (
        private config: ConfigService,
        private map: ConfigMapService,
        private notifications: NotificationsService,
        public t: BetterConfigerTranslator,
    ) {
        super()
    }

    ngOnInit (): void {
        this.reloadToggles()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.reloadToggles())
    }

    async setHideNativeConfigFile (value: boolean): Promise<void> {
        this.hideNativeConfigFile = value
        await this.writeToggle('hideNativeConfigFileTab', value)
    }

    async setHideNativeConfigSync (value: boolean): Promise<void> {
        this.hideNativeConfigSync = value
        await this.writeToggle('hideNativeConfigSyncTab', value)
    }

    private async writeToggle (key: string, value: boolean): Promise<void> {
        try {
            const raw = this.map.rawStore()
            raw.betterConfiger = raw.betterConfiger ?? {}
            raw.betterConfiger[key] = value
            await this.config.writeRaw(yaml.dump(raw))
        } catch (e: any) {
            this.notifications.error(e?.message ?? String(e))
        }
    }

    private reloadToggles (): void {
        const section = this.map.rawStore().betterConfiger ?? {}
        this.hideNativeConfigFile = section['hideNativeConfigFileTab'] === true
        this.hideNativeConfigSync = section['hideNativeConfigSyncTab'] === true
    }
}
