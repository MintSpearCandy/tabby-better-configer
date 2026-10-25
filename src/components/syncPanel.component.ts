import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core'
import { BaseComponent, ConfigService, NotificationsService } from 'tabby-core'

import { SyncSource, SyncSourcesService, PullPreview } from '../services/syncSources.service'
import { PushRejectedError } from '../services/gitSync.service'
import { SyncLogService } from '../services/syncLog.service'
import { BetterConfigerTranslator } from '../i18n'

/** Per-source busy marker, so rows disable independently. */
type Op = 'pull' | 'push' | 'branches'

/** In-app confirmation modal (replaces the Electron native dialogs — those
 *  are modal to the whole window, unstyleable, and unreachable for E2E). */
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

@Component({
    selector: 'bc-sync-panel',
    template: require('./syncPanel.component.pug'),
    styles: [require('./syncPanel.component.scss')],
})
export class SyncPanelComponent extends BaseComponent implements OnInit, OnDestroy {
    sources: SyncSource[] = []
    editing: SyncSource | null = null
    editingNew = false
    /** token draft + vault choice for the editor form (not part of the source
     *  until saved — the vault copy is written at save time) */
    draftToken = ''
    draftTokenInVault = true
    branches: string[] | null = null
    fetchingBranches = false
    busy = new Map<string, Op>()
    proxyDraft = ''
    showDebugLog = false
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
        // external writes (our own pull/push persist lastPull/lastPush; the
        // raw editor on the same page) refresh the list unless mid-edit
        this.subscribeUntilDestroyed(this.config.changed$, () => {
            if (!this.editing) {
                this.reload()
            }
        })
        this.subscribeUntilDestroyed(this.log.changed$, () => this.scrollToLogBottom())
        this.draftTokenInVault = this.sync.vaultAvailable
    }

    ngOnDestroy (): void {
        this.pickConfirm(null) // unblock any pending confirmation
        super.ngOnDestroy()
    }

    reload (): void {
        this.sources = this.sync.sources()
        this.proxyDraft = this.sync.proxyUrl()
        this.showDebugLog = this.sync.logDebug()
    }

    async toggleDebugLog (value: boolean): Promise<void> {
        this.showDebugLog = value
        try {
            await this.sync.setLogDebug(value)
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    isBusy (id: string, op: Op): boolean {
        return this.busy.get(id) === op
    }

    anyBusy (id: string): boolean {
        return this.busy.has(id)
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

    // ------------------------------------------------------------- editing ----

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
            this.reload()
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    async deleteSource (source: SyncSource): Promise<void> {
        const r = await this.confirm({
            title: this.t.t('betterConfiger.sync.deleteConfirm'),
            detail: `${source.name}\n${source.url} (${source.branch})`,
            buttons: [
                { label: this.t.t('betterConfiger.sync.delete'), className: 'btn btn-danger btn-sm', value: 0 },
                { label: this.t.t('betterConfiger.editor.cancel'), className: 'btn btn-secondary btn-sm', value: 1 },
            ],
        })
        if (r !== 0) {
            return
        }
        await this.sync.deleteSource(source.id)
        this.reload()
    }

    async refreshBranches (): Promise<void> {
        const src = this.editing!
        if (!src.url.trim()) {
            return
        }
        this.fetchingBranches = true
        try {
            // token draft so private repos list too
            const withToken = { ...src, tokenPlain: this.draftToken || src.tokenPlain }
            this.branches = await this.sync.listBranches(withToken)
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

    // -------------------------------------------------------------- proxy ----

    async saveProxy (): Promise<void> {
        try {
            await this.sync.setProxyUrl(this.proxyDraft)
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    /** Guards against the classic misfill: pasting the REPO url into the
     *  proxy box (observed in the wild — it silently breaks every sync). */
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

    // --------------------------------------------------------- operations ----

    async pull (source: SyncSource): Promise<void> {
        if (this.anyBusy(source.id)) {
            return
        }
        this.busy.set(source.id, 'pull')
        try {
            const preview: PullPreview = await this.sync.previewPull(source)
            if (!preview.report.ok) {
                this.notifications.error(`${this.t.t('betterConfiger.import.notAPackage')} (${source.path})`)
                return
            }
            const t = this.t
            const detail = [
                `${source.url} @ ${source.branch}`,
                `${preview.remote.oid.slice(0, 8)} ${preview.remote.message}`,
                `${t.t('betterConfiger.title')}: ${Object.keys(preview.pkg.modules ?? {}).join(', ') || '(empty)'}`,
                '',
                ...preview.report.issues.map(i => `[${i.level}] ${i.message}`),
            ].join('\n')
            const r = await this.confirm({
                title: t.t('betterConfiger.sync.pullConfirmTitle'),
                detail,
                buttons: [
                    { label: t.t('betterConfiger.import.mergeButton'), className: 'btn btn-primary btn-sm', value: 0 },
                    { label: t.t('betterConfiger.import.replaceButton'), className: 'btn btn-secondary btn-sm', value: 1 },
                    { label: t.t('betterConfiger.editor.cancel'), className: 'btn btn-secondary btn-sm', value: 2 },
                ],
            })
            if (r === null || r === 2) {
                return
            }
            const mode = r === 0 ? 'merge' : 'replace'
            const result = await this.sync.applyPull(source, preview, mode)
            const stats = result.profilesStats
                ? ` (profiles: +${result.profilesStats.added}, ~${result.profilesStats.overwritten})`
                : ''
            this.notifications.info(`${t.t('betterConfiger.import.applied')}${stats}`)
            this.reload()
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.pullFailed')}: ${e?.message ?? e}`)
        } finally {
            this.busy.delete(source.id)
        }
    }

    async push (source: SyncSource): Promise<void> {
        if (this.anyBusy(source.id)) {
            return
        }
        this.busy.set(source.id, 'push')
        try {
            const payload = this.sync.buildPushPayload(source)
            const t = this.t
            const detail = [
                `${source.url} @ ${source.branch} : ${source.path}`,
                `${t.t('betterConfiger.sync.pushSections')}: ${payload.sections.join(', ') || '(none)'}`,
                payload.excluded.length
                    ? `${t.t('betterConfiger.sync.pushExcluded')}: ${payload.excluded.join(', ')}`
                    : '',
            ].filter(Boolean).join('\n')
            const r = await this.confirm({
                title: t.t('betterConfiger.sync.pushConfirmTitle'),
                detail,
                buttons: [
                    { label: t.t('betterConfiger.sync.push'), className: 'btn btn-primary btn-sm', value: 0 },
                    { label: t.t('betterConfiger.editor.cancel'), className: 'btn btn-secondary btn-sm', value: 1 },
                ],
            })
            if (r !== 0) {
                return
            }
            try {
                const result = await this.sync.pushIfFastForward(source)
                this.notifications.info(`${t.t('betterConfiger.sync.pushDone')} (${result.sections})`)
            } catch (e) {
                if (!(e instanceof PushRejectedError)) {
                    throw e
                }
                const f = await this.confirm({
                    title: t.t('betterConfiger.sync.rejectedTitle'),
                    detail: t.t('betterConfiger.sync.rejectedDetail'),
                    buttons: [
                        { label: t.t('betterConfiger.sync.forceButton'), className: 'btn btn-danger btn-sm', value: 0 },
                        { label: this.t.t('betterConfiger.editor.cancel'), className: 'btn btn-secondary btn-sm', value: 1 },
                    ],
                })
                if (f === 0) {
                    const result = await this.sync.pushForce(source)
                    this.notifications.info(`${t.t('betterConfiger.sync.pushDone')} (${result.sections})`)
                }
            }
            this.reload()
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.pushFailed')}: ${e?.message ?? e}`)
        } finally {
            this.busy.delete(source.id)
        }
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

    /** Follow the log only when the user is already at the bottom (so
     *  reading history is not interrupted by new lines). */
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
