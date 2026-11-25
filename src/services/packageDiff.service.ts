import { Injectable } from '@angular/core'
import * as yaml from 'js-yaml'
import { diffLines, Change } from 'diff'

import { ConfigPackage } from './packageIO.service'

export type SectionChangeKind = 'added' | 'removed' | 'changed'

export interface SectionDiff {
    section: string
    kind: SectionChangeKind
    /** unified line diff of the section's YAML (old vs new) */
    lines: DiffLine[]
}

export interface DiffLine {
    text: string
    kind: 'add' | 'del' | 'ctx'
}

export interface PackageDiffResult {
    sections: SectionDiff[]
    /** stats line like "3 changed (1 added, 1 removed, 1 modified)" */
    summary: { added: number, removed: number, changed: number }
}

function toYaml (v: any): string {
    return v === undefined ? '' : yaml.dump(v, { lineWidth: 100 }).trimEnd()
}

function toDiffLines (changes: Change[]): DiffLine[] {
    const out: DiffLine[] = []
    for (const c of changes) {
        const kind = c.added ? 'add' : c.removed ? 'del' : 'ctx'
        for (const line of c.value.replace(/\n$/, '').split('\n')) {
            out.push({ text: line, kind })
        }
    }
    return out
}

/**
 * Section-level + line-level diff of two config packages. Powers the commit
 * detail view, the uncommitted-changes panel, the Apply preview and the
 * merge conflict dialog (ours/theirs side-by-side).
 */
@Injectable({ providedIn: 'root' })
export class PackageDiffService {
    diffPackages (oldPkg: ConfigPackage | null, newPkg: ConfigPackage | null): PackageDiffResult {
        const oldModules = oldPkg?.modules ?? {}
        const newModules = newPkg?.modules ?? {}
        const sections: SectionDiff[] = []
        const summary = { added: 0, removed: 0, changed: 0 }
        for (const section of new Set([...Object.keys(oldModules), ...Object.keys(newModules)])) {
            const before = oldModules[section]
            const after = newModules[section]
            let kind: SectionChangeKind
            if (before === undefined) {
                kind = 'added'
            } else if (after === undefined) {
                kind = 'removed'
            } else if (JSON.stringify(before) === JSON.stringify(after)) {
                continue
            } else {
                kind = 'changed'
            }
            summary[kind === 'changed' ? 'changed' : kind === 'added' ? 'added' : 'removed']++
            sections.push({
                section,
                kind,
                lines: toDiffLines(diffLines(toYaml(before), toYaml(after))),
            })
        }
        sections.sort((a, b) => a.section.localeCompare(b.section))
        return { sections, summary }
    }

    /** Side-by-side diff source for conflict rows (ours vs theirs). */
    sideDiff (ours: any, theirs: any): DiffLine[] {
        return toDiffLines(diffLines(toYaml(ours), toYaml(theirs)))
    }
}
