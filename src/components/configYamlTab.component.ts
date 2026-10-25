import { Component, OnInit } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService, NotificationsService } from 'tabby-core'
import * as yaml from 'js-yaml'

import { BetterConfigerTranslator } from '../i18n'

/**
 * The config.yaml sub-tab of the Config Manager: raw editing of the whole
 * file — validation, save-and-apply (writeRaw), read-only defaults preview,
 * reveal-in-folder. Same readRaw/writeRaw discipline as the module editor.
 */
@Component({
    selector: 'bc-config-yaml-tab',
    template: require('./configYamlTab.component.pug'),
    styles: [require('./configYamlTab.component.scss')],
})
export class ConfigYamlTabComponent extends BaseComponent implements OnInit {
    text = ''
    defaultsText: string | null = null
    showDefaults = false
    dirty = false
    yamlError: string | null = null
    saving = false

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        public t: BetterConfigerTranslator,
    ) {
        super()
    }

    ngOnInit (): void {
        this.reload()
        // external writes (other settings tabs, our own sync pull) refresh
        // the editor while the user has no unsaved edits
        this.subscribeUntilDestroyed(this.config.changed$, () => {
            if (!this.dirty) {
                this.reload()
            }
        })
    }

    get hasError (): boolean {
        return this.yamlError !== null
    }

    onEdit (value: string): void {
        this.text = value
        this.dirty = true
        this.validate()
    }

    async save (): Promise<void> {
        if (this.hasError || this.saving) {
            return
        }
        this.saving = true
        try {
            // clear dirty BEFORE writeRaw so the changed$ handler above
            // refreshes from disk instead of skipping
            this.dirty = false
            await this.config.writeRaw(this.text)
            this.notifications.info(this.t.t('betterConfiger.fileTab.saved'))
        } catch (e: any) {
            this.notifications.error(e?.message ?? String(e))
        } finally {
            this.saving = false
        }
    }

    discard (): void {
        this.reload()
    }

    toggleDefaults (): void {
        this.showDefaults = !this.showDefaults
        if (this.showDefaults && this.defaultsText === null) {
            this.defaultsText = yaml.dump(this.config.getDefaults())
        }
    }

    showInFolder (): void {
        const p = this.platform.getConfigPath()
        if (p) {
            this.platform.showItemInFolder(p)
        }
    }

    private reload (): void {
        this.text = this.config.readRaw()
        this.dirty = false
        this.validate()
    }

    private validate (): void {
        try {
            yaml.load(this.text)
            this.yamlError = null
        } catch (e: any) {
            const mark = e?.mark ? ` (line ${e.mark.line + 1})` : ''
            this.yamlError = `${e?.reason ?? e}${mark}`
        }
    }
}
