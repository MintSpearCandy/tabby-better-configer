import { Injectable } from '@angular/core'
import { configMerge } from 'tabby-core'

import { ConfigPackage } from './packageIO.service'
import { ID_MERGED_KEYS } from './configMap.service'

/** One top-level section both sides changed differently — the UI offers
 *  "use ours / use theirs" per section (section-level granularity,
 *  deliberately: finer slices complicate the dialog without covering real
 *  cases the deep/id-union merge below doesn't already handle). */
export interface MergeConflict {
    section: string
    ours: any
    theirs: any
}

export interface MergeStats {
    tookOurs: number
    tookTheirs: number
    deepMerged: number
    idUnioned: number
    conflicts: number
}

export interface MergeOutcome {
    /** merged package — conflicting sections carry OURS until resolved */
    merged: ConfigPackage
    conflicts: MergeConflict[]
    stats: MergeStats
}

export interface MergeDraft {
    /** three-way merge in progress: resolved sections already applied,
     *  conflicting sections still carry ours until resolvedSection() */
    merged: ConfigPackage
    conflicts: MergeConflict[]
    stats: MergeStats
    oursOid: string
    theirsOid: string
    fromRef: string
}

/** Order-insensitive deep equality (packages from different writers may
 *  serialize keys in different orders). */
function stableKey (v: any): string {
    if (v instanceof Array) {
        return `[${v.map(stableKey).join(',')}]`
    }
    if (v instanceof Object) {
        const keys = Object.keys(v).sort()
        return `{${keys.map(k => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`
    }
    return JSON.stringify(v) ?? 'null'
}

function eq (a: any, b: any): boolean {
    return a === b || stableKey(a) === stableKey(b)
}

function isPlainObject (v: any): v is Record<string, any> {
    return v instanceof Object && !(v instanceof Array)
}

type SectionOutcome =
    | { kind: 'ours' | 'theirs' | 'same', value: any }
    | { kind: 'deep' | 'idunion', value: any }
    | { kind: 'conflict' }

/** Three-way merge of one section value. */
function mergeSection (base: any, ours: any, theirs: any, isIdArray: boolean): SectionOutcome {
    if (eq(ours, theirs)) {
        return { kind: 'same', value: ours }
    }
    // one-sided ADDITION (no base, missing on one side) is not a conflict:
    // the side that has the section simply wins
    if (theirs === undefined && base === undefined) {
        return { kind: 'ours', value: ours }
    }
    if (ours === undefined && base === undefined) {
        return { kind: 'theirs', value: theirs }
    }
    const haveBase = base !== undefined
    if (haveBase && eq(ours, base)) {
        return { kind: 'theirs', value: theirs }
    }
    if (haveBase && eq(theirs, base)) {
        return { kind: 'ours', value: ours }
    }
    // both sides changed this section differently (or no base at all)
    if (isIdArray && Array.isArray(ours) && Array.isArray(theirs)) {
        const merged = mergeIdArray(Array.isArray(base) ? base : [], ours, theirs)
        if (merged) {
            return { kind: 'idunion', value: merged }
        }
        return { kind: 'conflict' }
    }
    if (isPlainObject(ours) && isPlainObject(theirs)) {
        const merged = mergeObjectDeep(isPlainObject(base) ? base : {}, ours, theirs)
        if (merged) {
            return { kind: 'deep', value: merged }
        }
    }
    return { kind: 'conflict' }
}

/** Per-key three-way merge of a plain-object section. Non-overlapping edits
 *  merge; a key changed on both sides differently fails the whole section
 *  (section-level granularity). Returns null on any inner conflict. */
function mergeObjectDeep (base: Record<string, any>, ours: Record<string, any>, theirs: Record<string, any>): Record<string, any> | null {
    const out: Record<string, any> = {}
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
        const o = ours[key]
        const t = theirs[key]
        const b = base[key]
        if (eq(o, t)) {
            out[key] = o
        } else if (eq(o, b)) {
            out[key] = t
        } else if (eq(t, b)) {
            out[key] = o
        } else if (isPlainObject(o) && isPlainObject(t)) {
            const nested = mergeObjectDeep(isPlainObject(b) ? b : {}, o, t)
            if (!nested) {
                return null
            }
            out[key] = nested
        } else {
            return null
        }
    }
    // deletions: keys removed on one side and untouched on the other stay removed
    for (const key of Object.keys(ours)) {
        if (!(key in out) && !(key in theirs)) {
            delete out[key]
        }
    }
    return out
}

/** Three-way union of id-keyed arrays (profiles/groups). Per id: identical →
 *  keep; one side untouched → take the changed side; both changed → section
 *  conflict (null). New ids from either side join the union. */
function mergeIdArray (base: any[], ours: any[], theirs: any[]): any[] | null {
    const byId = (arr: any[]) => new Map(arr.map(x => [x?.id, x]))
    const b = byId(base)
    const o = byId(ours)
    const t = byId(theirs)
    const out = new Map<string, any>()
    for (const id of new Set([...o.keys(), ...t.keys()])) {
        const ov = o.get(id)
        const tv = t.get(id)
        const bv = b.get(id)
        if (eq(ov, tv)) {
            if (ov !== undefined) {
                out.set(id, ov)
            }
            continue // deleted on both sides
        }
        if (bv !== undefined && eq(ov, bv)) {
            if (tv === undefined) {
                return null // deleted there, changed here — let the user decide
            }
            out.set(id, tv)
        } else if (bv !== undefined && eq(tv, bv)) {
            if (ov === undefined) {
                return null // deleted here, changed there
            }
            out.set(id, ov)
        } else {
            return null // both changed this id differently
        }
    }
    // preserve ours-side order for ids both sides kept/new
    const oursOrder = ours.map(x => x?.id).filter(id => out.has(id))
    const rest = [...out.keys()].filter(id => !oursOrder.includes(id))
    return [...oursOrder, ...rest].map(id => out.get(id))
}

/**
 * Semantic three-way merge of config packages at section granularity.
 * Pure logic (no git, no Angular state) — the engine feeds it blobs from
 * ours/theirs/merge-base commits, the UI feeds conflicts back via
 * resolveSection().
 */
@Injectable({ providedIn: 'root' })
export class PackageMergeService {
    merge (ours: ConfigPackage, theirs: ConfigPackage, base: ConfigPackage | null): MergeOutcome {
        const stats: MergeStats = { tookOurs: 0, tookTheirs: 0, deepMerged: 0, idUnioned: 0, conflicts: 0 }
        const conflicts: MergeConflict[] = []
        const mergedSections: Record<string, any> = {}
        const oursModules = ours.modules ?? {}
        const theirsModules = theirs.modules ?? {}
        const baseModules = base?.modules ?? {}
        for (const section of new Set([...Object.keys(oursModules), ...Object.keys(theirsModules)])) {
            const o = oursModules[section]
            const t = theirsModules[section]
            const b = baseModules[section]
            const isIdArray = ID_MERGED_KEYS.includes(section)
            const result = mergeSection(b, o, t, isIdArray)
            switch (result.kind) {
                case 'same':
                    mergedSections[section] = result.value
                    break
                case 'ours':
                    mergedSections[section] = result.value
                    stats.tookOurs++
                    break
                case 'theirs':
                    mergedSections[section] = result.value
                    stats.tookTheirs++
                    break
                case 'deep':
                    mergedSections[section] = result.value
                    stats.deepMerged++
                    break
                case 'idunion':
                    mergedSections[section] = result.value
                    stats.idUnioned++
                    break
                case 'conflict':
                    mergedSections[section] = o // ours until resolved
                    conflicts.push({ section, ours: o, theirs: t })
                    stats.conflicts++
                    break
            }
        }
        const merged: ConfigPackage = {
            ...ours,
            exportedAt: new Date().toISOString(),
            modules: mergedSections,
            excluded: [...new Set([...(ours.excluded ?? []), ...(theirs.excluded ?? [])])],
        }
        return { merged, conflicts, stats }
    }

    /** Apply the user's per-conflict choice onto a merge draft. */
    resolveSection (draft: MergeDraft, section: string, side: 'ours' | 'theirs'): void {
        const conflict = draft.conflicts.find(c => c.section === section)
        if (!conflict) {
            return
        }
        if (side === 'theirs') {
            draft.merged.modules[section] = conflict.theirs
            draft.stats.tookTheirs++
        } else {
            draft.merged.modules[section] = conflict.ours
            draft.stats.tookOurs++
        }
        draft.stats.conflicts--
        draft.conflicts = draft.conflicts.filter(c => c.section !== section)
    }

    /** Short stable signature of a section value for UI previews. */
    previewOf (value: any): string {
        const text = JSON.stringify(value)
        if (!text) {
            return ''
        }
        return text.length > 160 ? text.slice(0, 157) + '…' : text
    }

    /** configMerge passthrough kept for callers needing plain two-way deep merge. */
    twoWayDeep (ours: Record<string, any>, theirs: Record<string, any>): Record<string, any> {
        return configMerge(ours, theirs)
    }
}
