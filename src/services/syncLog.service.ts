import { Injectable } from '@angular/core'
import { app } from '@electron/remote'
import * as fs from 'fs'
import * as path from 'path'
import { Subject } from 'rxjs'

export type SyncLogLevel = 'debug' | 'info' | 'success' | 'error'

export interface SyncLogEntry {
    at: string
    level: SyncLogLevel
    op: string
    message: string
    detail?: string
}

const MAX_ENTRIES = 800
const ROTATE_AT = 2 * 1024 * 1024
const TRIM_TO = 512 * 1024

/**
 * Bounded in-memory + on-disk activity log for git config sync.
 *
 * Motivation: sync failures (network blocking, bad proxy, auth) previously
 * surfaced only as transient notification toasts — by the time the user
 * looked, the reason was gone. The log window renders `entries`; the file
 * (<userData>/better-configer/sync.log) survives restarts for post-mortem.
 *
 * Log lines are deliberately English/technical regardless of UI locale
 * (grep-able, and the E2E asserts on them).
 */
@Injectable({ providedIn: 'root' })
export class SyncLogService {
    entries: SyncLogEntry[] = []
    changed$ = new Subject<void>()

    get filePath (): string | null {
        try {
            return path.join(app.getPath('userData'), 'better-configer', 'sync.log')
        } catch {
            return null
        }
    }

    debug (op: string, message: string, detail?: string): void {
        this.log('debug', op, message, detail)
    }

    info (op: string, message: string, detail?: string): void {
        this.log('info', op, message, detail)
    }

    success (op: string, message: string, detail?: string): void {
        this.log('success', op, message, detail)
    }

    error (op: string, message: string, detail?: string): void {
        this.log('error', op, message, detail)
    }

    log (level: SyncLogLevel, op: string, message: string, detail?: string): void {
        const entry: SyncLogEntry = { at: new Date().toISOString(), level, op, message, detail }
        this.entries.push(entry)
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES)
        }
        this.appendToFile(entry)
        this.changed$.next()
    }

    clear (): void {
        this.entries = []
        const file = this.filePath
        if (file) {
            try {
                fs.writeFileSync(file, '')
            } catch {
                // best-effort
            }
        }
        this.info('log', 'log cleared')
    }

    formatLine (e: SyncLogEntry): string {
        const time = new Date(e.at).toTimeString().slice(0, 8)
        const line = `[${time}] ${e.level.toUpperCase().padEnd(7)} ${e.op.padEnd(8)} ${e.message}`
        return e.detail ? `${line}\n    ${e.detail.replace(/\n/g, '\n    ')}` : line
    }

    private appendToFile (e: SyncLogEntry): void {
        const file = this.filePath
        if (!file) {
            return
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.appendFileSync(file, this.formatLine(e) + '\n')
            const size = fs.statSync(file).size
            if (size > ROTATE_AT) {
                const buf = fs.readFileSync(file)
                const cut = buf.indexOf(10, Math.max(0, buf.length - TRIM_TO))
                fs.writeFileSync(file, cut >= 0 ? buf.slice(cut + 1) : buf.slice(-TRIM_TO))
            }
        } catch {
            // the log file is best-effort; never let it break a sync
        }
    }
}
