/**
 * Loads dist/index.js the way Tabby's renderer would (module evaluation
 * only), with the host modules stubbed. Any module-scope crash (the kind
 * that makes a plugin silently fail to load) reproduces here.
 *
 *   node scripts/smokeLoad.js
 */
const Module = require('module')
const path = require('path')
const assert = require('assert')

// ---------------------------------------------------------------- stubs ---
function decorator () { return (cls) => cls }

const Injector = class Injector {}
class NgZone { run (fn) { return fn() } runOutsideAngular (fn) { return fn() } }
class ChangeDetectorRef { detectChanges () {} }

const ngCore = new Proxy({
    Injector,
    NgZone,
    ChangeDetectorRef,
    // things only referenced as types get erased, but design:paramtypes
    // metadata requires them as values
    Component: decorator,
    NgModule: decorator,
    Injectable: (...a) => (cls, ...rest) => {
        // @Injectable({ providedIn: 'root' }) takes args
        return typeof cls === 'function' ? cls : decorator()
    },
    Input: decorator,
    ViewChild: decorator,
}, { get (t, k) { if (k in t) return t[k]; return decorator } })

class BaseComponent {}
class ConfigProvider {}
class ConfigService { readRaw () { return '{}' } }
class PlatformService {}
class HostAppService {}
class NotificationsService { info () {} error () {} }
class LocaleService { getLocale () { return 'en' } }

function strictProxy (target, name) {
    return new Proxy(target, {
        get (t, k) {
            if (k === '__esModule' || typeof k === 'symbol') {
                return undefined
            }
            if (k in t) {
                return t[k]
            }
            throw new Error(`${name} export missing in stub: ${String(k)}`)
        },
    })
}

const tabbyCore = strictProxy({
    BaseComponent,
    ConfigProvider,
    ConfigService,
    PlatformService,
    HostAppService,
    NotificationsService,
    LocaleService,
    configMerge: (a, b) => b,
    TabbyCoreModule: {},
}, 'tabby-core')

const tabbySettings = strictProxy({
    SettingsTabProvider: class SettingsTabProvider {},
}, 'tabby-settings')

const electronRemote = {
    app: { getVersion: () => '0.0.0-smoke' },
}

const STUBS = {
    '@angular/core': ngCore,
    '@angular/common': { CommonModule: {} },
    '@angular/forms': { FormsModule: {} },
    'tabby-core': tabbyCore,
    'tabby-settings': tabbySettings,
    '@electron/remote': electronRemote,
}

// Patch require BEFORE loading the bundle. The webpack UMD wrapper /
// external requires go through Module._load.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) {
        return STUBS[request]
    }
    return origLoad.apply(this, [request, parent, isMain])
}

// ---------------------------------------------------------------- load ----
const dist = path.resolve(__dirname, '..', 'dist', 'index.js')
console.log('Loading', dist)
const mod = origLoad(dist, null, false)

assert.strictEqual(typeof mod.default, 'function', 'default export must be the NgModule class')
const exported = Object.keys(mod).filter(k => k !== 'default')
console.log('[ok] module evaluated; default export:', mod.default.name || '(anonymous)')
console.log('[ok] named exports:', exported.join(', ') || '(none)')
console.log('[ok] smoke load passed')
