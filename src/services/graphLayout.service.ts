import { Injectable } from '@angular/core'
import { GitgraphCore, TemplateName, templateExtend, toSvgPath, Orientation } from '@gitgraph/core'

import { GraphCommit } from './gitSync.service'

/** Row height of the commit list AND the graph — one constant so the two
 *  layers (absolute full-height SVG + DOM rows on top) always line up. */
export const ROW_HEIGHT = 30

/** Left padding before the first lane. */
export const LANE_LEFT = 16

/** One dot on the graph, in list coordinates (x from left, y = row centre). */
export interface GraphDot {
    oid: string
    x: number
    y: number
    color: string
    isHead: boolean
    isMerge: boolean
}

/** One branch lane, as an SVG path d-string in list coordinates. */
export interface GraphPath {
    d: string
    color: string
    name: string
}

export interface GraphView {
    dots: GraphDot[]
    paths: GraphPath[]
    /** lane colour per ref name (branch labels use it) */
    colorOf: Map<string, string>
    /** pixels needed by the lane area (grows with concurrent branches) */
    laneWidth: number
    /** total px height = rows * ROW_HEIGHT */
    height: number
    laneCount: number
}

/** Metro palette, cycled per lane — stable so a branch keeps its colour
 *  across reloads as long as its lane index does. */
export const LANE_COLORS = [
    '#979797', // lane 0: main-ish grey (matches gitgraph Metro's default)
    '#008fb5',
    '#f1c109',
    '#fb026e',
    '#5f6a52',
    '#9a5fb4',
    '#2ecc71',
    '#e67e22',
]

/**
 * Turns a git log (with refs) into render-ready graph geometry.
 *
 * Layout comes from @gitgraph/core (lane assignment + bezier branch paths).
 * What this class adds on top:
 *  - branch ownership: each ref's first-parent chain claims its commits, so
 *    "which lane is this commit in" follows the ref it belongs to;
 *  - coordinates are rewritten into LIST space: y = row index * ROW_HEIGHT,
 *    x = lane * spacing — so the SVG can be one absolutely positioned layer
 *    under the scrolling commit rows instead of a per-row clipped tile.
 */
@Injectable({ providedIn: 'root' })
export class GraphLayoutService {
    layout (commits: GraphCommit[], headBranch: string, headOid: string | null): GraphView {
        if (!commits.length) {
            return { dots: [], paths: [], colorOf: new Map(), laneWidth: LANE_LEFT * 2, height: 0, laneCount: 0 }
        }
        const byOid = new Map(commits.map(c => [c.oid, c]))

        // ---- branch ownership: walk each ref's first-parent chain ----
        const branchOf = new Map<string, string>()
        const refHeads: Array<{ name: string, oid: string }> = []
        for (const c of commits) {
            for (const ref of c.refs) {
                refHeads.push({ name: ref, oid: c.oid })
            }
        }
        // local refs claim first (they win over origin/* on shared history)
        refHeads.sort((a, b) => (a.name.startsWith('origin/') ? 1 : 0) - (b.name.startsWith('origin/') ? 1 : 0))
        const claim = (start: string | undefined, name: string): void => {
            let cur = start
            let guard = 0
            while (cur && byOid.has(cur) && guard++ < 2000) {
                if (branchOf.has(cur)) {
                    return
                }
                branchOf.set(cur, name)
                cur = byOid.get(cur)!.parents[0]
            }
        }
        for (const head of refHeads) {
            claim(head.oid, head.name)
        }
        // side chains reachable only as merge side-parents
        for (const head of refHeads) {
            const c = byOid.get(head.oid)
            c?.parents.slice(1).forEach(p => claim(p, head.name))
        }
        const branchFor = (oid: string): string => branchOf.get(oid) ?? headBranch

        // ---- replay into gitgraph (oldest → newest) ----
        const template = templateExtend(TemplateName.Metro, {
            commit: { spacing: ROW_HEIGHT, dot: { size: 10 } },
            branch: { label: { display: false } },
        })
        const core = new GitgraphCore({ template, orientation: Orientation.VerticalReverse })
        const api = core.getUserApi()
        const branchObjs = new Map<string, any>()
        const getBranch = (name: string, fromHash?: string): any => {
            let b = branchObjs.get(name)
            if (!b) {
                b = fromHash ? api.branch({ name, from: fromHash }) : api.branch(name)
                branchObjs.set(name, b)
            }
            return b
        }
        for (const c of commits) {
            const name = branchFor(c.oid)
            const author = { name: c.author || 'unknown', email: 'e@e' }
            if (c.parents.length >= 2) {
                const srcName = branchFor(c.parents[1])
                const target = getBranch(name, c.parents[0] && branchFor(c.parents[0]) !== name ? c.parents[0] : undefined)
                const src = getBranch(srcName, c.parents[1])
                try {
                    target.merge({ branch: src, hash: c.oid, subject: c.message, author })
                } catch {
                    target.commit({ hash: c.oid, subject: c.message, author })
                }
                continue
            }
            const branch = getBranch(name, c.parents[0] && branchFor(c.parents[0]) !== name ? c.parents[0] : undefined)
            branch.commit({ hash: c.oid, subject: c.message, author })
        }
        const data = core.getRenderedData()

        // ---- rewrite coordinates into list space ----
        // The list shows NEWEST first; gitgraph renders oldest at y=0 (we
        // chose VerticalReverse). So list-row(commit) = (rows-1) - graph-row.
        const rendered = data.commits as any[]
        const rows = rendered.length
        const spacing = Number(template.commit.spacing) || ROW_HEIGHT
        const laneSpacing = Number(template.branch.spacing) || LANE_LEFT
        const xOf = new Map<string, number>()
        for (const c of rendered) {
            if (!xOf.has(String(c.hash))) {
                xOf.set(String(c.hash), Number(c.x) || 0)
            }
        }
        const dots: GraphDot[] = rendered.map(c => {
            const hash = String(c.hash)
            const src = byOid.get(hash)
            const gx = Number(c.x) || 0
            const gy = Number(c.y) || 0
            return {
                oid: hash,
                x: LANE_LEFT + gx,
                y: (rows - 1 - Math.round(gy / spacing)) * ROW_HEIGHT + ROW_HEIGHT / 2,
                color: LANE_COLORS[Math.round(gx / laneSpacing) % LANE_COLORS.length] ?? '#979797',
                isHead: headOid === hash,
                isMerge: (src?.parents.length ?? 0) >= 2,
            }
        })

        const colorOf = new Map<string, string>()
        for (const c of rendered) {
            const b = branchFor(String(c.hash))
            if (!colorOf.has(b)) {
                const lane = Math.round((Number(c.x) || 0) / laneSpacing)
                colorOf.set(b, LANE_COLORS[lane % LANE_COLORS.length] ?? '#979797')
            }
        }

        const paths: GraphPath[] = []
        for (const [branch, coords] of data.branchesPaths as any) {
            // flip y of every point into list space, then hand to gitgraph's
            // own path builder (it draws the beziers)
            const flipped = (coords as Array<Array<{ x: number, y: number }>>).map(seg =>
                seg.map(p => ({
                    x: Number(p.x) || 0,
                    y: (rows * ROW_HEIGHT) - (Number(p.y) || 0) - ROW_HEIGHT / 2,
                })),
            )
            const shifted = flipped.map(seg => seg.map(p => ({ x: p.x + LANE_LEFT, y: p.y })))
            const d = toSvgPath(shifted as any, true, true)
            if (d) {
                paths.push({ d, color: colorOf.get(branch.name) ?? '#666', name: branch.name })
            }
        }

        const maxX = dots.reduce((m, d) => Math.max(m, d.x), 0)
        const laneCount = Math.max(1, Math.round(maxX / laneSpacing) + 1)
        return {
            dots,
            paths,
            colorOf,
            laneWidth: Math.max(LANE_LEFT * 2, maxX + LANE_LEFT),
            height: rows * ROW_HEIGHT,
            laneCount,
        }
    }
}
