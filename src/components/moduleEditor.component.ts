import { Component, Input, OnChanges, SimpleChanges } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService, NotificationsService } from 'tabby-core'
import * as yaml from 'js-yaml'

import { KeyInfo, ConfigMapService } from '../services/configMap.service'
import { PackageIOService } from '../services/packageIO.service'
import { BetterConfigerTranslator } from '../i18n'

/** Sections whose settings commonly require an app restart to take effect. */
const RESTART_HINT_KEYS = ['hacks', 'electronFlags', 'terminal', 'appearance']

/** Hide ConfigProxy's internal `__nonStructural` markers from what the user
 *  sees (they can leak into the persisted store when host code reads a
 *  non-structural default). Display-only: writes go through the unmodified
 *  raw store. */
function stripNonStructural (v: any): any {
    if (v instanceof Array) {
        return v.map(stripNonStructural)
    }
    if (v instanceof Object) {
        const r = {}
        for (const k of Object.keys(v)) {
            if (k !== '__nonStructural') {
                r[k] = stripNonStructural(v[k])
            }
        }
        return r
    }
    return v
}

@Component({
    selector: 'bc-module-editor',
    template: require('./moduleEditor.component.pug'),
    styles: [require('./moduleEditor.component.scss')],
})
export class ModuleEditorComponent extends BaseComponent implements OnChanges {
    @Input() key: string
    @Input() keyInfo: KeyInfo | null = null

    text = ''
    defaultsText = ''
    activeTab: 'current' | 'defaults' = 'current'
    dirty = false
    yamlError: string | null = null
    notSet = false
    saving = false

    constructor (
        private config: ConfigService,
        private map: ConfigMapService,
        private io: PackageIOService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private t: BetterConfigerTranslator,
    ) {
        super()
    }

    ngOnChanges (changes: SimpleChanges): void {
        // Only a section SWITCH is a full reload. The parent rebinds keyInfo
        // with a fresh object reference on every config.changed$ (it rebuilds
        // the whole group tree); reloading then would silently kick the user
        // off the Defaults tab back to Current.
        if (changes['key']) {
            this.reload()
        }
    }

    ngOnInit (): void {
        // External changes (other settings tabs, our own import) refresh the
        // editor as long as the user has no unsaved edits.
        this.subscribeUntilDestroyed(this.config.changed$, () => {
            if (!this.dirty) {
                this.reload()
            }
        })
    }

    get hasError (): boolean {
        return this.yamlError !== null
    }

    get showRestartHint (): boolean {
        return RESTART_HINT_KEYS.includes(this.key)
    }

    get showProfilesWarning (): boolean {
        return this.key === 'profiles' || this.key === 'groups'
    }

    /** Editor textarea binding: current value while editing, defaults preview
     *  (read-only) on the other tab. */
    get editorText (): string {
        return this.activeTab === 'current' ? this.text : this.defaultsText
    }

    onEdit (value: string): void {
        if (this.activeTab !== 'current') {
            return
        }
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
            const parsed = this.text.trim() ? yaml.load(this.text) : undefined
            const raw = this.map.rawStore()
            if (parsed === undefined || parsed === null) {
                delete raw[this.key]
            } else {
                raw[this.key] = parsed
            }
            // Order matters: clear dirty BEFORE writeRaw so the changed$
            // handler (see ngOnInit) refreshes instead of skipping.
            this.dirty = false
            await this.config.writeRaw(yaml.dump(raw))
            this.reload()
            this.notifications.info(this.t.t('betterConfiger.editor.saved'))
        } catch (e: any) {
            this.notifications.error(e?.message ?? String(e))
        } finally {
            this.saving = false
        }
    }

    discard (): void {
        this.reload()
    }

    async exportModule (): Promise<void> {
        let includeSensitive = true
        if (this.keyInfo?.sensitive) {
            const r = await this.platform.showMessageBox({
                type: 'warning',
                buttons: [
                    this.t.t('betterConfiger.editor.export'),
                    this.t.t('betterConfiger.editor.cancel'),
                ],
                defaultId: 1,
                cancelId: 1,
                message: this.t.t('betterConfiger.export.sensitiveTitle'),
                detail: this.t.t('betterConfiger.export.sensitiveQuestion'),
            })
            if (r.response !== 0) {
                return
            }
        }
        try {
            await this.io.exportToFile('module', [this.key], includeSensitive)
            this.notifications.info(this.t.t('betterConfiger.export.done'))
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.export.failed')}: ${e?.message ?? e}`)
        }
    }

    private reload (): void {
        const raw = this.map.rawStore()
        this.notSet = !(this.key in raw) || raw[this.key] === undefined
        this.text = this.notSet ? '' : yaml.dump(stripNonStructural(raw[this.key]))
        this.defaultsText = yaml.dump(stripNonStructural(this.map.defaultsForKey(this.key) ?? null))
        this.dirty = false
        this.yamlError = null
        this.activeTab = 'current'
    }

    private validate (): void {
        if (!this.text.trim()) {
            this.yamlError = null
            return
        }
        try {
            yaml.load(this.text)
            this.yamlError = null
        } catch (e: any) {
            const mark = e?.mark ? ` (line ${e.mark.line + 1})` : ''
            this.yamlError = `${e?.reason ?? e}${mark}`
        }
    }
}
