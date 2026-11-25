import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'tabby-core'

import { SyncSource, SyncSourcesService } from '../services/syncSources.service'
import { SyncLogService } from '../services/syncLog.service'
import { BetterConfigerTranslator } from '../i18n'

interface ConfirmButton {
    label: string
    className: string
    value: number
}

interface ConfirmRequest {
    title: string
    detail: string
    buttons: ConfirmButton[]
}

/**
 * Shell of the Git sync sub-tab: source management (select / add / edit /
 * delete), proxy box, sync log — with the IDE-style git browser
 * (bc-git-browser) mounted for the selected source.
 */
@Component({
    selector: 'bc-sync-panel',
    template: require('./syncPanel.component.pug'),
    styles: [require('./syncPanel.component.scss')],
})
export class SyncPanelComponent extends BaseComponent implements OnInit, OnDestroy {
    sources: SyncSource[] = []
    editing: SyncSource | null = null
    editingNew = false
    draftToken = ''
    draftTokenInVault = true
    branches: string[] | null = null
    fetchingBranches = false
    proxyDraft = ''
    showDebugLog = false
    /** collapsed by default — the commit list gets the space */
    logCollapsed = true
    confirmReq: ConfirmRequest | null = null
    private confirmResolve: ((v: number | null) => void) | null = null
    @ViewChild('logScroll') logScrollEl: ElementRef | null = null

    constructor (
        private config: ConfigService,
        public sync: SyncSourcesService,
        public log: SyncLogService,
        private notifications: NotificationsService,
        public t: BetterConfigerTranslator,
    ) {
        super()
    }

    ngOnInit (): void {
        this.reload()
        this.subscribeUntilDestroyed(this.config.changed$, () => {
            if (!this.editing) {
                this.reload()
            }
        })
        this.subscribeUntilDestroyed(this.log.changed$, () => this.scrollToLogBottom())
        this.draftTokenInVault = this.sync.vaultAvailable
    }

    ngOnDestroy (): void {
        this.pickConfirm(null)
        super.ngOnDestroy()
    }

    reload (): void {
        this.sources = this.sync.sources()
        this.proxyDraft = this.sync.proxyUrl()
        this.showDebugLog = this.sync.logDebug()
        if (this.sync.expandedWsId && !this.sources.some(s => s.id === this.sync.expandedWsId)) {
            this.sync.expandedWsId = null
        }
        if (!this.sync.expandedWsId && this.sources.length && !this.editing) {
            this.sync.expandedWsId = this.sources[0].id
        }
    }

    get selectedSource (): SyncSource | null {
        return this.sources.find(s => s.id === this.sync.expandedWsId) ?? null
    }

    selectSource (source: SyncSource): void {
        if (this.editing) {
            return
        }
        this.sync.expandedWsId = source.id
    }

    // ------------------------------------------------------- confirm modal ----

    confirm (req: ConfirmRequest): Promise<number | null> {
        this.confirmReq = req
        return new Promise(resolve => {
            this.confirmResolve = resolve
        })
    }

    pickConfirm (value: number | null): void {
        const resolve = this.confirmResolve
        this.confirmReq = null
        this.confirmResolve = null
        resolve?.(value)
    }

    // -------------------------------------------------------------- proxy ----

    async saveProxy (): Promise<void> {
        try {
            await this.sync.setProxyUrl(this.proxyDraft)
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    get proxyLooksWrong (): boolean {
        const v = this.proxyDraft.trim()
        if (!v) {
            return false
        }
        if (!/^https?:\/\//i.test(v)) {
            return true
        }
        return /\.git(\?|$)/i.test(v) || /github\.com|gitlab|gitee/i.test(v)
    }

    async toggleDebugLog (value: boolean): Promise<void> {
        this.showDebugLog = value
        try {
            await this.sync.setLogDebug(value)
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    // ------------------------------------------------------------- editor ----

    startEdit (source?: SyncSource): void {
        this.branches = null
        this.editingNew = !source
        this.editing = source
            ? { ...source }
            : {
                id: this.sync.newId(),
                name: '',
                url: '',
                branch: 'main',
                path: 'tabby-config.json',
                mode: 'merge',
                includeSensitive: false,
            }
        this.draftToken = ''
        this.draftTokenInVault = this.sync.vaultAvailable
    }

    cancelEdit (): void {
        this.editing = null
    }

    async saveEdit (): Promise<void> {
        const src = this.editing!
        if (!src.name.trim() || !src.url.trim() || !src.branch.trim() || !src.path.trim()) {
            this.notifications.error(this.t.t('betterConfiger.sync.needFields'))
            return
        }
        try {
            if (this.sync.vaultAvailable && this.draftTokenInVault) {
                await this.sync.setToken(src, this.draftToken || null)
                src.tokenInVault = !!this.draftToken
                delete src.tokenPlain
            } else {
                src.tokenPlain = this.draftToken || undefined
                src.tokenInVault = false
            }
            await this.sync.saveSource(src)
            this.editing = null
            this.sync.expandedWsId = src.id
            this.reload()
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    async deleteSource (source: SyncSource): Promise<void> {
        const r = await this.confirm({
            title: this.t.t('betterConfiger.sync.deleteConfirm'),
            detail: `${source.name}\n${source.url} (origin/${source.branch})`,
            buttons: [
                { label: this.t.t('betterConfiger.sync.delete'), className: 'btn btn-danger btn-sm', value: 0 },
                { label: this.t.t('betterConfiger.editor.cancel'), className: 'btn btn-secondary btn-sm', value: 1 },
            ],
        })
        if (r !== 0) {
            return
        }
        await this.sync.deleteSource(source.id)
        this.sync.wsCache.delete(source.id)
        if (this.sync.expandedWsId === source.id) {
            this.sync.expandedWsId = null
        }
        this.reload()
    }

    async refreshBranches (): Promise<void> {
        const src = this.editing!
        if (!src.url.trim()) {
            return
        }
        this.fetchingBranches = true
        try {
            const withToken = { ...src, tokenPlain: this.draftToken || src.tokenPlain }
            this.branches = await this.sync.listServerBranches(withToken)
        } catch (e: any) {
            this.branches = null
            this.notifications.error(`${this.t.t('betterConfiger.sync.branchesFailed')}: ${e?.message ?? e}`)
        } finally {
            this.fetchingBranches = false
        }
    }

    pickBranch (branch: string): void {
        this.editing!.branch = branch
    }

    tokenBadge (source: SyncSource): string {
        if (source.tokenInVault) {
            return this.t.t('betterConfiger.sync.tokenVaultBadge')
        }
        if (source.tokenPlain) {
            return this.t.t('betterConfiger.sync.tokenPlainBadge')
        }
        return ''
    }

    get logErrorCount (): number {
        return this.log.entries.reduce((n, e) => n + (e.level === 'error' ? 1 : 0), 0)
    }

    // ---------------------------------------------------------------- log ----

    copyLog (): void {
        try {
            const text = this.log.entries.map(e => this.log.formatLine(e)).join('\n')
            require('@electron/remote').clipboard.writeText(text)
            this.notifications.info(this.t.t('betterConfiger.sync.logCopied'))
        } catch {
            // clipboard unavailable — the log text remains selectable
        }
    }

    private scrollToLogBottom (force = false): void {
        const el = this.logScrollEl?.nativeElement as HTMLElement | undefined
        if (!el) {
            return
        }
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        if (force || nearBottom) {
            el.scrollTop = el.scrollHeight
        }
    }
}
