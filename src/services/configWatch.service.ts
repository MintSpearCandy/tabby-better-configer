import { Injectable, Inject } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import * as fs from 'fs'

import { ConfigMapService } from './configMap.service'
import { SyncLogService } from './syncLog.service'

/**
 * Live cross-window config synchronization.
 *
 * WHY: every Tabby window is its own renderer with its own ConfigService —
 * config.yaml is read ONCE at startup and later writes from other windows
 * are never picked up. Two open windows then disagree on everything
 * config-backed, most visibly the ORDER of saved sessions (profiles/groups):
 * reorder in one window, the other keeps the stale order until restarted.
 *
 * WHAT: watch config.yaml (fs.watch + mtime polling as a safety net); when
 * the file's content differs from what THIS window believes (i.e. someone
 * else wrote it — another window, or any external editor), re-apply it via
 * writeRaw(). writeRaw reloads the store and broadcasts changed$ inside this
 * window, so every config-backed UI (profiles tree, quick connect, settings)
 * refreshes live. Our own writes are recognized (content already equals
 * readRaw) and ignored, so the windows do not echo-loop.
 */
@Injectable({ providedIn: 'root' })
export class ConfigWatchService {
    private started = false
    private lastApplied: string | null = null

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        @Inject(ConfigMapService) private map: ConfigMapService,
        private syncLog: SyncLogService,
    ) { }

    start (): void {
        if (this.started) {
            return
        }
        this.started = true
        const path = this.platform.getConfigPath()
        if (!path) {
            return
        }
        this.syncLog.debug('xwin', `watching ${path}`)
        let timer: any = null
        const debounce = () => {
            clearTimeout(timer)
            timer = setTimeout(() => this.consider(path), 500)
        }
        // self-healing watch: an error kills the handle (e.g. the config save
        // swaps the file) — re-arm instead of going deaf permanently
        const armWatch = () => {
            try {
                const watcher = fs.watch(path, debounce)
                watcher.on('error', () => {
                    watcher.close()
                    setTimeout(armWatch, 2000)
                })
            } catch {
                // fs.watch unavailable — polling below still covers us
            }
        }
        armWatch()
        // mtime polling safety net (hand-rolled): fs.watch can die silently
        // on this platform (config saves swap the file), and fs.watchFile
        // proved unreliable in the same conditions — a plain 2s stat
        // comparison is dumb but cannot go deaf
        let lastMtime = 0
        try {
            lastMtime = fs.statSync(path).mtimeMs
        } catch { /* non-fatal */ }
        setInterval(() => {
            try {
                const mtime = fs.statSync(path).mtimeMs
                if (mtime !== lastMtime) {
                    lastMtime = mtime
                    debounce()
                }
            } catch { /* transient */ }
        }, 2000)
    }

    private async consider (path: string): Promise<void> {
        try {
            if (this.map.rawStore()?.betterConfiger?.crossWindowSync === false) {
                return // opt-out
            }
            let next: string | null = null
            // the app itself writes config.yaml frequently; hitting its write
            // lock (EBUSY) once must not swallow the event — retry briefly
            for (let i = 0; i < 4; i++) {
                try {
                    next = fs.readFileSync(path, 'utf8')
                    break
                } catch {
                    await new Promise(r => setTimeout(r, 400))
                }
            }
            if (next === null) {
                this.syncLog.debug('xwin', 'could not read config.yaml (busy) — waiting for next event')
                return
            }
            const current = this.config.readRaw()
            if (next === current || next === this.lastApplied) {
                return // our own write's echo, or already applied
            }
            this.lastApplied = next
            this.syncLog.info('xwin', 'config.yaml changed externally — reloading this window')
            await this.config.writeRaw(next)
        } catch (e: any) {
            this.syncLog.debug('xwin', `consider failed: ${String(e?.message ?? e).slice(0, 120)}`)
        }
    }
}
