import { Component, Input, OnChanges, SimpleChanges, ViewChild, ElementRef, HostListener, NgZone, ChangeDetectorRef } from '@angular/core'
import { BaseComponent, NotificationsService } from 'tabby-core'

import {
    SyncSource, SyncSourcesService, WorkspaceState, MergeUiDraft,
} from '../services/syncSources.service'
import { PushRejectedError, GraphCommit } from '../services/gitSync.service'
import { GraphLayoutService, GraphView, ROW_HEIGHT, LANE_COLORS } from '../services/graphLayout.service'
import { layoutLanes, LaneLayout, LaneSegment } from '../services/laneLayout'
import { PackageDiffService, PackageDiffResult } from '../services/packageDiff.service'
import { ConfigPackage } from '../services/packageIO.service'
import { BetterConfigerTranslator } from '../i18n'

interface OpModal {
    kind: 'commit' | 'merge' | 'conflicts' | 'apply' | 'push' | 'branch' | 'reset'
    source: SyncSource
    message?: string
    diff?: PackageDiffResult
    fromRef?: string
    draft?: MergeUiDraft
    choices?: Record<string, 'ours' | 'theirs'>
    mode?: 'merge' | 'replace'
    outgoing?: { oid: string, message: string }[]
    force?: boolean
    newName?: string
    newFrom?: string
    resetOid?: string
}

const LANE_LEFT = 14

function parsePackage (text: string | null): ConfigPackage | null {
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

interface CtxMenu {
    x: number
    y: number
    oid: string
}

/**
 * Git Graph style browser (modelled on the VS Code "Git Graph" extension):
 *
 *   [branch ▾] [sync state]        Fetch  Commit(n)  Push(n)  Apply  Update
 *   [filter commits…]                      repo · file
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ●─╮  main, origin/main   Merge feature-x        E2E  a1b2c3d  10-25 │  ← full-width rows
 *   │ │ ●  feature-x            feat work              E2E  9f8e7d6  10-25 │
 *   └──────────────────────────────────────────────────────────────────┘
 *   ▾ a1b2c3d Merge feature-x                                 reset   ×   ← collapsible detail
 *
 * The graph is ONE absolutely positioned SVG under the scrolling rows (same
 * row height), so lanes stay continuous instead of being re-clipped per row.
 */
@Component({
    selector: 'bc-git-browser',
    template: require('./gitBrowser.component.pug'),
    styles: [require('./gitBrowser.component.scss')],
})
export class GitBrowserComponent extends BaseComponent implements OnChanges {
    @Input() source: SyncSource
    @ViewChild('historyScroll') historyScrollEl: ElementRef | null = null

    readonly ROW_HEIGHT = ROW_HEIGHT

    ws: WorkspaceState | null = null
    graph: GraphView = { dots: [], paths: [], colorOf: new Map(), laneWidth: 0, height: 0, laneCount: 0 }
    graphCommits: GraphCommit[] = []
    headOid: string | null = null

    selectedOid: string | null = null
    selectedDiff: PackageDiffResult | null = null
    selectedLoading = false
    /** monotonically increasing id of the latest selection request; a
     *  response whose id is not the latest is stale and gets discarded. */
    private selectSeq = 0
    /** per-commit diff cache: re-selecting a commit is then synchronous */
    private diffCache = new Map<string, PackageDiffResult | null>()
    detailCollapsed = false
    collapsedSections = new Set<string>()

    branchMenuOpen = false
    branchFilter: string | null = null
    commitFilter = ''
    ctxMenu: CtxMenu | null = null
    modal: OpModal | null = null
    busyOp: string | null = null

    /** per-commit connector segments, built once per graph (see rebuildSegments) */

    constructor (
        public sync: SyncSourcesService,
        private layout: GraphLayoutService,
        public diffSvc: PackageDiffService,
        private notifications: NotificationsService,
        public t: BetterConfigerTranslator,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
    ) {
        super()
    }

    ngOnChanges (_changes: SimpleChanges): void {
        this.branchFilter = null
        this.commitFilter = ''
        this.selectedOid = null
        this.selectedDiff = null
        this.reload()
    }

    get busy (): boolean {
        return this.busyOp !== null
    }

    async reload (): Promise<void> {
        if (!this.source) {
            return
        }
        try {
            this.ws = await this.sync.loadWorkspace(this.source)
            this.graphCommits = await this.sync.git.graphLog(this.source)
            this.headOid = this.ws.history[0]?.oid ?? null
            this.graph = this.layout.layout(this.graphCommits, this.ws.localBranch, this.headOid)
            this.lanes = null
            this.diffCache.clear()
            this.colorCache.clear()
            this.visibleCache = null
            this.ancestorCache.clear()
            this.pushedSet = null
            this.colorKey = String(this.graphCommits.length)
            if (this.selectedOid && !this.graphCommits.some(c => c.oid === this.selectedOid)) {
                this.selectedOid = null
                this.selectedDiff = null
            }
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    // --------------------------------------------------------- view model ----

    /** newest first, narrowed to the selected branch and the text filter */
    /**
     * The rows on screen: newest first, narrowed by the branch filter and the
     * text filter.
     *
     * MEMOIZED on its inputs. This getter is evaluated for every row on every
     * change-detection pass (row count, lane rebuild, template bindings), so
     * recomputing the filters — and especially the ancestor walk — inside it
     * made the list O(rows²) per frame once a branch filter was active.
     */
    get visibleCommits (): GraphCommit[] {
        const key = `${this.graphCommits.length}|${this.headOid ?? ''}|${this.branchFilter ?? ''}|${this.commitFilter}`
        if (this.visibleCache && key === this.visibleKey) {
            return this.visibleCache
        }
        let list = this.graphCommits.slice().reverse()
        if (this.branchFilter) {
            const ancestors = this.ancestorsOf(this.branchFilter)
            list = list.filter(c => ancestors.has(c.oid))
        }
        const q = this.commitFilter.trim().toLowerCase()
        if (q) {
            list = list.filter(c =>
                c.message.toLowerCase().includes(q) || c.oid.toLowerCase().startsWith(q) ||
                c.author.toLowerCase().includes(q) || c.refs.some(r => r.toLowerCase().includes(q)))
        }
        this.visibleCache = list
        this.visibleKey = key
        // the row→commit mapping changed, so lanes and row lookups are stale
        this.lanes = null
        this.pushedSet = null
        return list
    }

    private visibleCache: GraphCommit[] | null = null
    private visibleKey = ''
    private ancestorCache = new Map<string, Set<string>>()
    private pushedSet: Set<string> | null = null
    private byOidCache = new Map<string, GraphCommit>()

    private get byOid (): Map<string, GraphCommit> {
        if (this.byOidCache.size !== this.graphCommits.length) {
            this.byOidCache = new Map(this.graphCommits.map(c => [c.oid, c]))
        }
        return this.byOidCache
    }

    /** every commit reachable from `ref` (its tip and all ancestors) —
     *  computed once per ref, not once per row */
    private ancestorsOf (ref: string): Set<string> {
        let set = this.ancestorCache.get(ref)
        if (set) {
            return set
        }
        set = new Set<string>()
        const stack = this.graphCommits.filter(c => c.refs.includes(ref)).map(c => c.oid)
        while (stack.length) {
            const oid = stack.pop()!
            if (set.has(oid)) {
                continue
            }
            set.add(oid)
            for (const p of this.byOid.get(oid)?.parents ?? []) {
                stack.push(p)
            }
        }
        this.ancestorCache.set(ref, set)
        return set
    }

    trackByOid (_i: number, c: GraphCommit): string {
        return c.oid
    }

    dotOf (oid: string) {
        return this.graph.dots.find(d => d.oid === oid) ?? null
    }

    colorOf (ref: string): string {
        return this.graph.colorOf.get(ref) ?? '#979797'
    }

    shortOid (oid: string): string {
        return oid.slice(0, 7)
    }

    isPushed (c: GraphCommit): boolean {
        if (!this.pushedSet) {
            this.pushedSet = new Set((this.ws?.history ?? []).filter(h => h.pushed).map(h => h.oid))
        }
        return this.pushedSet.has(c.oid)
    }

    detailCommit (): GraphCommit | null {
        return this.graphCommits.find(c => c.oid === this.selectedOid) ?? null
    }

    get remoteUrlShort (): string {
        return (this.source?.url ?? '').replace(/^https?:\/\//, '')
    }

    syncStateText (): string {
        if (!this.ws) {
            return ''
        }
        const parts: string[] = []
        if (this.ws.ahead) {
            parts.push(`${this.ws.ahead} ${this.t.t('betterConfiger.sync.gg.ahead')}`)
        }
        if (this.ws.behind) {
            parts.push(`${this.ws.behind} ${this.t.t('betterConfiger.sync.gg.behind')}`)
        }
        if (!parts.length) {
            return this.t.t('betterConfiger.sync.gg.inSync')
        }
        return parts.join(' · ')
    }

    /** sources offered by Merge / Create-branch: remotes first, then locals
     *  other than the current one. */
    get mergeSources (): Array<{ ref: string, label: string }> {
        const out: Array<{ ref: string, label: string }> = []
        for (const b of this.ws?.remoteBranches ?? []) {
            out.push({ ref: `origin/${b}`, label: `origin/${b}` })
        }
        for (const b of this.ws?.localBranches ?? []) {
            if (b !== this.ws?.localBranch) {
                out.push({ ref: b, label: `${b} (${this.t.t('betterConfiger.sync.ws.local')})` })
            }
        }
        return out
    }

    // ---------------------------------------------------------------- lanes ----

    /**
     * Lane geometry for the CURRENT visible rows (see services/laneLayout.ts).
     * Recomputed whenever the visible set changes — cheap (a few hundred
     * commits) and pure, so the getter can drive it.
     */
    private lanes: LaneLayout | null = null
    private laneKey = ''

    private ensureLanes (): LaneLayout {
        const list = this.visibleCommits
        const key = `${list.length}|${list[0]?.oid ?? ''}|${list[list.length - 1]?.oid ?? ''}|${this.headOid}|${this.colorKey}`
        if (!this.lanes || key !== this.laneKey) {
            const known = new Set(this.graphCommits.map(c => c.oid))
            this.lanes = layoutLanes(list, {
                rowHeight: ROW_HEIGHT,
                colorOf: oid => this.colorOfCommit(oid),
                headOid: this.headOid,
                known: oid => known.has(oid),
            })
            this.laneKey = key
        }
        return this.lanes
    }

    /** px height of the scroll content: one ROW_HEIGHT band per visible row */
    get historyHeight (): number {
        return Math.max(this.visibleCommits.length * ROW_HEIGHT, 1)
    }

    get laneWidth (): number {
        return this.lanes?.width ?? LANE_LEFT * 2
    }

    /** lane colour of a commit: from its own refs, else inherited from the
     *  nearest ref that reaches it (so an unnamed side chain stays one colour) */
    private colorCache = new Map<string, string>()
    private colorKey = ''
    private colorOfCommit (oid: string): string {
        let c = this.colorCache.get(oid)
        if (!c) {
            const commit = this.byOid.get(oid)
            const refs = commit?.refs ?? []
            const local = refs.find(r => !r.startsWith('origin/'))
            c = (local && this.colorOf(local)) || (refs[0] && this.colorOf(refs[0])) || LANE_COLORS[0]
            this.colorCache.set(oid, c)
        }
        return c
    }

    segmentsOf (row: number): LaneSegment[] {
        return this.ensureLanes().segsOf(row)
    }

    dotAt (row: number) {
        return this.ensureLanes().dotOf(row)
    }

    // -------------------------------------------------------------- filter ----

    toggleBranchMenu (event: MouseEvent): void {
        // stopPropagation: the document-level HostListener closes menus on any
        // click — including this very click if it is allowed to bubble up
        event.stopPropagation()
        this.branchMenuOpen = !this.branchMenuOpen
    }

    pickBranch (ref: string): void {
        if (this.branchFilter === ref) {
            this.branchFilter = null
        } else if (ref.startsWith('origin/')) {
            this.branchFilter = ref // remote: filter only (cannot check out)
        } else if (ref === this.ws?.localBranch) {
            this.branchFilter = this.branchFilter === ref ? null : ref
        } else {
            this.switchTo(ref)
        }
        this.branchMenuOpen = false
    }

    clearBranchFilter (): void {
        this.branchFilter = null
    }

    toggleSection (section: string): void {
        if (this.collapsedSections.has(section)) {
            this.collapsedSections.delete(section)
        } else {
            this.collapsedSections.add(section)
        }
    }

    // ---------------------------------------------------------- context menu ----

    openContextMenu (event: MouseEvent, c: GraphCommit): void {
        event.preventDefault()
        this.selectedOid = c.oid
        void this.selectCommit(c.oid)
        this.ctxMenu = { x: event.clientX, y: event.clientY, oid: c.oid }
    }

    ctxSelect (): void {
        this.detailCollapsed = false
        this.ctxMenu = null
    }

    ctxReset (): void {
        const oid = this.ctxMenu!.oid
        this.ctxMenu = null
        this.opReset(oid)
    }

    ctxClose (): void {
        this.ctxMenu = null
    }

    @HostListener('document:click')
    onDocumentClick (): void {
        this.branchMenuOpen = false
        this.ctxMenu = null
    }

    @HostListener('document:keydown.escape')
    onEscape (): void {
        this.branchMenuOpen = false
        this.ctxMenu = null
    }

    // -------------------------------------------------------------- details ----

    /**
     * Load and show the diff of one commit.
     *
     * Correctness rules (each fixes a bug seen in practice):
     *  - STALE RESPONSES ARE DISCARDED: rapid clicks start several loads;
     *    without a sequence number the first one to resolve would clear the
     *    loading flag (and overwrite the diff) of the one the user is actually
     *    looking at — the pane then sat in "Loading diff…" until some
     *    unrelated event re-ran change detection.
     *  - the previous diff is cleared at once, so the pane never shows
     *    commit A's lines under commit B's hash.
     *  - results are committed inside the Angular zone (and change detection
     *    is run explicitly): the git engine resolves from fs callbacks that
     *    may run outside the zone.
     *  - results are cached per commit (immutable), so re-selecting and
     *    arrow-key browsing feel instant.
     */
    async selectCommit (oid: string): Promise<void> {
        const seq = ++this.selectSeq
        this.selectedOid = oid
        this.selectedDiff = null
        this.detailCollapsed = false
        if (this.diffCache.has(oid)) {
            this.selectedDiff = this.diffCache.get(oid) ?? null
            this.selectedLoading = false
            return
        }
        this.selectedLoading = true
        try {
            const pair = await this.sync.git.commitPackages(this.source, oid)
            if (seq !== this.selectSeq) {
                return // a newer selection superseded this one
            }
            const diff = this.diffSvc.diffPackages(parsePackage(pair.parent), parsePackage(pair.current))
            this.diffCache.set(oid, diff)
            this.commit(() => {
                this.selectedDiff = diff
                this.selectedLoading = false
            })
        } catch (e: any) {
            if (seq !== this.selectSeq) {
                return
            }
            this.commit(() => {
                this.selectedDiff = null
                this.selectedLoading = false
            })
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        }
    }

    /** apply a view update inside the zone and make sure it gets rendered */
    private commit (update: () => void): void {
        const run = () => {
            update()
            try {
                this.cdr.detectChanges()
            } catch {
                // view already destroyed (user switched sub-tab) — nothing to do
            }
        }
        if (NgZone.isInAngularZone()) {
            run()
        } else {
            this.zone.run(run)
        }
    }

    /** drop cached diffs (after any operation that rewrites history) */
    private invalidateDiffCache (): void {
        this.diffCache.clear()
    }

    // ---------------------------------------------------------------- ops ----

    async runOp (op: string, fn: () => Promise<string | void>): Promise<void> {
        if (this.busy) {
            return
        }
        this.busyOp = op
        try {
            const message = await fn()
            if (typeof message === 'string') {
                this.notifications.info(message)
            }
            await this.reload()
            if (this.selectedOid) {
                void this.selectCommit(this.selectedOid)
            }
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        } finally {
            this.busyOp = null
        }
    }

    opUpdate (): void {
        this.runOp('update', async () => {
            const result = await this.sync.updateAndApply(this.source)
            const stats = result?.profilesStats
                ? ` (profiles: +${result.profilesStats.added}, ~${result.profilesStats.overwritten})` : ''
            return `${this.t.t('betterConfiger.sync.ws.updated')}${stats}`
        })
    }

    opFetch (): void {
        this.runOp('fetch', async () => {
            const heads = await this.sync.fetchRefs(this.source)
            return `${this.t.t('betterConfiger.sync.ws.fetched')} (${heads.length})`
        })
    }

    opCommit (): void {
        if (!this.ws) {
            return
        }
        this.modal = {
            kind: 'commit',
            source: this.source,
            message: '',
            diff: this.diffSvc.diffPackages(this.ws.headPackage, this.sync.currentPackage(this.source)),
        }
    }

    opMerge (fromRef?: string): void {
        const sources = this.mergeSources
        const preferred = fromRef
            ?? (sources.some(s => s.ref === `origin/${this.source.branch}`) ? `origin/${this.source.branch}` : sources[0]?.ref)
        this.modal = { kind: 'merge', source: this.source, fromRef: preferred }
    }

    opApply (): void {
        if (!this.ws) {
            return
        }
        this.modal = {
            kind: 'apply',
            source: this.source,
            mode: this.source.mode,
            diff: this.diffSvc.diffPackages(this.sync.currentPackage(this.source), this.ws.headPackage),
        }
    }

    opPush (): void {
        const outgoing = (this.ws?.history ?? []).filter(h => !h.pushed).slice(0, 20)
            .map(h => ({ oid: h.oid, message: h.message }))
        this.modal = { kind: 'push', source: this.source, outgoing, force: false }
    }

    opBranches (): void {
        this.modal = {
            kind: 'branch',
            source: this.source,
            newName: '',
            newFrom: this.mergeSources[0]?.ref ?? '',
        }
        this.branchMenuOpen = false
    }

    opReset (oid: string): void {
        this.modal = { kind: 'reset', source: this.source, resetOid: oid }
    }

    aheadBehindOf (branch: string): { ahead: number, behind: number } | null {
        // the current branch has live numbers; others show none until fetched
        return branch === this.ws?.localBranch && (this.ws?.ahead || this.ws?.behind)
            ? { ahead: this.ws!.ahead, behind: this.ws!.behind } : null
    }

    async switchTo (name: string): Promise<void> {
        await this.runOp('branch', async () => {
            await this.sync.switchBranch(this.source, name)
            return `${this.t.t('betterConfiger.sync.ws.switch')}: ${name}`
        })
    }

    async deleteBranch (name: string): Promise<void> {
        await this.runOp('branch', async () => {
            await this.sync.deleteBranch(this.source, name)
            return `${this.t.t('betterConfiger.sync.ws.branchDeleted')}: ${name}`
        })
    }

    closeModal (): void {
        this.modal = null
    }

    async submitCommit (): Promise<void> {
        const m = this.modal!
        await this.runOp('commit', async () => {
            if (!(m.diff?.sections.length)) {
                return this.t.t('betterConfiger.sync.ws.nothingToCommit')
            }
            const message = (m.message ?? '').trim() || `Config snapshot (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`
            await this.sync.commitFromConfig(this.source, message)
            return this.t.t('betterConfiger.sync.ws.committed')
        })
        this.closeModal()
    }

    async submitMerge (): Promise<void> {
        const m = this.modal!
        const fromRef = m.fromRef ?? ''
        if (!fromRef) {
            return
        }
        this.busyOp = 'merge'
        try {
            const outcome = await this.sync.mergeInto(this.source, fromRef)
            if ('committed' in outcome) {
                this.notifications.info(this.t.t('betterConfiger.sync.ws.merged'))
                this.closeModal()
                await this.reload()
            } else {
                this.modal = { kind: 'conflicts', source: m.source, draft: outcome, choices: {} }
            }
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        } finally {
            this.busyOp = null
        }
    }

    pickSide (section: string, side: 'ours' | 'theirs'): void {
        const m = this.modal!
        m.choices = { ...(m.choices ?? {}), [section]: side }
    }

    sideLabel (section: string): string {
        const side = this.sideOf(section)
        const arrow = side === 'ours' ? '← ' : '→ '
        return arrow + (side === 'ours' ? this.t.t('betterConfiger.sync.ws.useOurs') : this.t.t('betterConfiger.sync.ws.useTheirs'))
    }

    sideOf (section: string): 'ours' | 'theirs' {
        return this.modal?.choices?.[section] ?? 'theirs'
    }

    resolvedCount (): number {
        return Object.keys(this.modal?.choices ?? {}).length
    }

    async submitConflicts (): Promise<void> {
        const m = this.modal!
        this.busyOp = 'merge'
        try {
            await this.sync.resolveMerge(m.source, m.draft!, m.choices ?? {})
            this.notifications.info(this.t.t('betterConfiger.sync.ws.merged'))
            this.closeModal()
            await this.reload()
        } catch (e: any) {
            this.notifications.error(`${this.t.t('betterConfiger.sync.failed')}: ${e?.message ?? e}`)
        } finally {
            this.busyOp = null
        }
    }

    async submitApply (): Promise<void> {
        const m = this.modal!
        await this.runOp('apply', async () => {
            const result = await this.sync.applyToConfig(this.source, m.mode ?? 'merge')
            const stats = result.profilesStats
                ? ` (profiles: +${result.profilesStats.added}, ~${result.profilesStats.overwritten})` : ''
            return `${this.t.t('betterConfiger.sync.ws.applied')}${stats}`
        })
        this.closeModal()
    }

    async submitPush (): Promise<void> {
        const m = this.modal!
        await this.runOp('push', async () => {
            try {
                await this.sync.pushWorkspace(this.source, m.force ?? false)
                return this.t.t('betterConfiger.sync.ws.pushDone')
            } catch (e) {
                if (!(e instanceof PushRejectedError)) {
                    throw e
                }
                throw new Error(this.t.t('betterConfiger.sync.ws.rejectedHint'))
            }
        })
        this.closeModal()
    }

    async submitCreateBranch (): Promise<void> {
        const m = this.modal!
        const name = (m.newName ?? '').trim()
        if (!name) {
            return
        }
        await this.runOp('branch', async () => {
            await this.sync.createBranch(this.source, name, m.newFrom || undefined)
            return `${this.t.t('betterConfiger.sync.ws.branchCreated')}: ${name}`
        })
        this.closeModal()
    }

    async submitReset (): Promise<void> {
        const m = this.modal!
        await this.runOp('branch', async () => {
            await this.sync.git.resetTo(this.source, m.resetOid!)
            return `${this.t.t('betterConfiger.sync.ws.resetDone')}: ${m.resetOid!.slice(0, 8)}`
        })
        this.closeModal()
        this.selectedOid = null
        this.selectedDiff = null
    }
}

