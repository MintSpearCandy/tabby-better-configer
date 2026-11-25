/**
 * Row-based commit-graph lane layout (the "git log --graph" algorithm).
 *
 * Input: the commits in DISPLAY order (newest first) and a colour lookup.
 * Output, per row index: the dot's lane/x and the lane segments that cross
 * that row. All geometry is ROW-LOCAL (y in 0..rowHeight), so each list row
 * is a self-contained SVG — and because the layout runs over whatever rows
 * are currently visible, filtering / searching simply re-flows the graph
 * instead of leaving holes or misaligned lines.
 *
 * Model: `lanes[i]` tracks which commit oid lane i is travelling towards.
 * Walking newest→oldest:
 *   1. a lane whose target is this commit ARRIVES — curve it into the dot
 *   2. the dot takes one of the arriving lanes, else a free lane
 *   3. parent[0] continues straight down from the dot
 *   4. further parents (merge) fan out below the dot into their own lanes
 *   5. every other lane passes straight through
 */

export interface LaneInputCommit {
    oid: string
    parents: string[]
}

export interface RowDot {
    x: number
    color: string
    isHead: boolean
    isMerge: boolean
}

export interface LaneSegment {
    d: string
    color: string
}

export interface LaneLayout {
    rowHeight: number
    width: number
    dotOf: (row: number) => RowDot | null
    segsOf: (row: number) => LaneSegment[]
}

export interface LaneOptions {
    rowHeight?: number
    laneSpacing?: number
    left?: number
    /** stable colour per commit (typically derived from its refs) */
    colorOf: (oid: string) => string
    headOid?: string | null
    /** oids known to the graph — parents outside it are ignored */
    known?: (oid: string) => boolean
}

export function layoutLanes (commits: LaneInputCommit[], opts: LaneOptions): LaneLayout {
    const rowHeight = opts.rowHeight ?? 30
    const spacing = opts.laneSpacing ?? 18
    const left = opts.left ?? 14
    const known = opts.known ?? (() => true)
    const half = rowHeight / 2

    type Lane = { target: string | null, color: string }
    const lanes: Lane[] = []
    const dots = new Map<number, RowDot>()
    const segs = new Map<number, LaneSegment[]>()

    const line = (x: number, y1: number, y2: number, color: string): LaneSegment =>
        ({ d: `M${x} ${y1} L${x} ${y2}`, color })
    const curve = (x1: number, y1: number, x2: number, y2: number, color: string): LaneSegment =>
        ({ d: `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`, color })
    const xOf = (lane: number) => left + lane * spacing

    commits.forEach((c, row) => {
        const out: LaneSegment[] = []
        const parents = c.parents.filter(p => p !== c.oid && known(p))
        const myColor = opts.colorOf(c.oid)

        // (1)+(5) pass-through, and collect lanes arriving at this commit
        const arriving: number[] = []
        for (let l = 0; l < lanes.length; l++) {
            if (lanes[l].target === c.oid) {
                arriving.push(l)
            } else {
                out.push(line(xOf(l), 0, rowHeight, lanes[l].color))
            }
        }

        // (2) the dot's lane
        let dotLane = arriving.length ? arriving[0] : -1
        if (dotLane === -1) {
            dotLane = lanes.findIndex(l => l.target === null)
            if (dotLane === -1) {
                dotLane = lanes.length
                lanes.push({ target: null, color: myColor })
            }
        }
        const dotX = xOf(dotLane)
        dots.set(row, { x: dotX, color: myColor, isHead: c.oid === (opts.headOid ?? null), isMerge: parents.length > 1 })

        // fan-in: the other arriving lanes curve into the dot
        for (const l of arriving) {
            if (l !== dotLane) {
                out.push(curve(xOf(l), 0, dotX, half, lanes[l].color))
            }
            lanes[l] = { target: null, color: lanes[l].color }
        }
        // a reused arriving lane still needs its "from above" half drawn
        if (arriving.length && arriving[0] === dotLane) {
            out.push(line(dotX, 0, half, myColor))
        }
        lanes[dotLane] = { target: null, color: myColor }

        // (3) first parent straight down
        if (parents.length) {
            out.push(line(dotX, half, rowHeight, myColor))
            lanes[dotLane] = { target: parents[0], color: myColor }
        }
        // (4) further parents fan out
        for (let pi = 1; pi < parents.length; pi++) {
            const target = parents[pi]
            const targetColor = opts.colorOf(target)
            let tl = lanes.findIndex(l => l.target === target)
            if (tl === -1) {
                tl = lanes.findIndex((l, idx) => l.target === null && idx !== dotLane)
                if (tl === -1) {
                    tl = lanes.length
                    lanes.push({ target: null, color: targetColor })
                }
                lanes[tl] = { target, color: targetColor }
            }
            out.push(curve(dotX, half, xOf(tl), rowHeight, targetColor))
        }
        segs.set(row, out)
    })

    return {
        rowHeight,
        width: Math.max(left * 2, left + lanes.length * spacing),
        dotOf: row => dots.get(row) ?? null,
        segsOf: row => segs.get(row) ?? [],
    }
}
