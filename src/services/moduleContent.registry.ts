import { Injectable } from '@angular/core'

/**
 * Dispatch table for per-section custom content components. Returning null
 * makes the Config Manager fall back to the generic YAML editor.
 *
 * v1 always returns null; v2 will plug a structured profiles form in here
 * (key 'profiles') without touching the surrounding navigation code.
 */
@Injectable({ providedIn: 'root' })
export class ModuleContentRegistry {
    getComponentType (key: string): any | null {
        void key
        return null
    }
}
