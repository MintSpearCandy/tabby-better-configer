import { Component, Input } from '@angular/core'

import { DiffLine } from '../services/packageDiff.service'

/** Unified line diff renderer (red/green). Pure display. */
@Component({
    selector: 'bc-diff-view',
    template: require('./diffView.component.pug'),
    styles: [require('./diffView.component.scss')],
})
export class DiffViewComponent {
    @Input() lines: DiffLine[] = []
    /** context lines kept around add/del hunks (rest collapsed away) */
    @Input() context = 2
    @Input() compact = false

    /** collapse long runs of context lines to changed ± context */
    get visibleLines (): DiffLine[] {
        if (!this.lines.length) {
            return []
        }
        const keep = new Array<boolean>(this.lines.length).fill(false)
        this.lines.forEach((l, i) => {
            if (l.kind !== 'ctx') {
                for (let j = Math.max(0, i - this.context); j <= Math.min(this.lines.length - 1, i + this.context); j++) {
                    keep[j] = true
                }
            }
        })
        const out: DiffLine[] = []
        let skipped = false
        this.lines.forEach((l, i) => {
            if (keep[i]) {
                if (skipped) {
                    out.push({ text: '⋯', kind: 'ctx' })
                    skipped = false
                }
                out.push(l)
            } else {
                skipped = true
            }
        })
        return out
    }
}
