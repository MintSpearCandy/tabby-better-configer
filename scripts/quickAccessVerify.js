/** CDP verification for the Quick access block + section search (bc instance).
 *  End-to-end: gear button → Config Manager tab → quick entries → click-through
 *  selection → search filtering → Esc restore → no-match hint.
 *  Usage: node quickAccessVerify.js [port]
 *
 *  NOTE: the instance restores tabs across runs, so stale (hidden) settings
 *  tabs with old component state may still be in the DOM — every query is
 *  scoped to the LAST VISIBLE <better-configer> element. */
const PORT = Number(process.argv[2] || 9233)

const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const ok = (name, cond, detail = '') => {
    console.log(`[${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' — ' + detail}`)
    if (!cond) failures++
}

/** JS snippet: the visible plugin instance (inactive Tabby tabs are display:none) */
const ROOT = `([...document.querySelectorAll('better-configer')].filter(e => e.offsetParent !== null).slice(-1)[0])`
const qall = sel => `(() => { const r = ${ROOT}; return r ? [...r.querySelectorAll('${sel}')] : [] })()`
const qtext = sel => `${qall(sel)}.filter(e => e.offsetParent !== null).map(e => e.textContent.trim())`

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('no main window')
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
        }
    })
    const send = (method, params = {}) => new Promise(r => {
        const i = ++id
        pending.set(i, r)
        ws.send(JSON.stringify({ id: i, method, params }))
    })
    const evalJs = async expression => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true })
        if (r.result?.exceptionDetails) {
            throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails))
        }
        return r.result?.result?.value
    }

    // pluginModules fills progressively at startup — poll up to 30s
    let loaded = false
    for (let i = 0; i < 30; i++) {
        loaded = await evalJs(`!!(window.pluginModules ?? []).some(m => m.pluginName === 'better-configer')`)
        if (loaded) break
        await sleep(1000)
    }
    ok('plugin loaded', loaded)

    // open Settings via the gear toolbar button (SVG cog, not an fa class)
    const gear = await evalJs(`(() => {
        const btns = [...document.querySelectorAll('.tab-bar .btn-tab-bar')]
        const g = btns.find(b => [...b.querySelectorAll('svg path')].some(p => (p.getAttribute('d') ?? '').startsWith('M255.1 512c-56.05')))
        if (!g) return 'no-gear: ' + btns.length
        g.click()
        return 'clicked'
    })()`)
    ok('settings opened', gear === 'clicked', String(gear))
    await sleep(800)

    // switch to the Config Manager settings tab (in the NEWLY opened settings tab)
    const pill = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('settings-tab')].filter(e => e.offsetParent !== null)
        const links = [...(tabs[tabs.length - 1] ?? document).querySelectorAll('.nav-pills a')]
        const ours = links.find(a => /Config Manager|配置管理/.test(a.textContent))
        if (!ours) return 'no-pill: ' + links.map(l => l.textContent.trim()).join('|')
        ours.click()
        return 'clicked'
    })()`)
    ok('config manager tab opened', pill === 'clicked', String(pill))
    await sleep(500)

    // the gear REUSES an existing settings tab (ButtonProvider.open →
    // selectTab), so a leftover search string from a previous run would
    // filter everything — reset it before asserting
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-search'); if (el && el.value) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) } })()`)
    await sleep(200)

    // A. quick access block: exactly the curated keys, in order
    const quickKeys = await evalJs(qtext('.bc-quick-entry .bc-quick-key'))
    ok('quick entries (curated, ordered)', JSON.stringify(quickKeys) === JSON.stringify(['profiles', 'groups', 'appearance', 'hotkeys', 'terminal']), JSON.stringify(quickKeys))
    const quickLabels = await evalJs(qtext('.bc-quick-entry .bc-quick-label'))
    console.log('      labels:', JSON.stringify(quickLabels))
    const icons = await evalJs(`${qall('.bc-quick-entry .bc-quick-icon')}.map(e => e.className)`)
    ok('quick icons applied', icons.length === 5 && icons.every(c => /fa-plug|fa-layer-group|fa-columns|fa-keyboard|fa-terminal/.test(c)), JSON.stringify(icons))

    // B. click 连接配置/profiles → editor shows profiles AND its group expanded
    await evalJs(`${ROOT}?.querySelector('.bc-quick-entry')?.click()`)
    await sleep(300)
    const editorKey = await evalJs(`${ROOT}?.querySelector('bc-module-editor .bc-key-name')?.textContent.trim()`)
    ok('click profiles → editor shows profiles', editorKey === 'profiles', String(editorKey))
    const treeShowsProfiles = await evalJs(`${qall('.bc-plugin-group .bc-key-name')}.some(e => e.textContent.trim() === 'profiles' && e.closest('.bc-keys') !== null && e.offsetParent !== null)`)
    ok('profiles group auto-expanded in tree', treeShowsProfiles)
    const activeQuick = await evalJs(`${ROOT}?.querySelector('.bc-quick-entry.active .bc-quick-key')?.textContent.trim()`)
    ok('quick entry active state', activeQuick === 'profiles', String(activeQuick))

    // C. search 'hot' → only hotkeys key visible in tree, quick filtered
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-search'); if (!el) return 'no-input'; el.value = 'hot'; el.dispatchEvent(new Event('input', { bubbles: true })); return 'set' })()`)
    await sleep(300)
    const visibleTreeKeys = await evalJs(qtext('.bc-plugin-group .bc-key-name'))
    // hotkeys is a SHARED key (declared by every builtin plugin group), so
    // expect every row to be hotkeys, one per declaring group
    ok("search 'hot' filters tree to hotkeys", visibleTreeKeys.length > 1 && visibleTreeKeys.every(k => k === 'hotkeys'), JSON.stringify(visibleTreeKeys))
    const visibleQuick = await evalJs(qtext('.bc-quick-entry .bc-quick-key'))
    ok("search 'hot' filters quick block", JSON.stringify(visibleQuick) === JSON.stringify(['hotkeys']), JSON.stringify(visibleQuick))

    // D. Esc → search cleared, tree restored
    await evalJs(`(() => { ${ROOT}?.querySelector('.bc-search')?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })) })()`)
    await sleep(300)
    const restoredKeys = await evalJs(`${qtext('.bc-plugin-group .bc-key-name')}.length`)
    const restoredQuick = await evalJs(`${qall('.bc-quick-entry')}.length`)
    const searchValue = await evalJs(`${ROOT}?.querySelector('.bc-search')?.value`)
    ok('Esc clears search', searchValue === '' && restoredKeys > 3 && restoredQuick === 5, `value="${searchValue}" treeKeys=${restoredKeys} quick=${restoredQuick}`)

    // E. nonsense query → no-match hint
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-search'); if (el) { el.value = 'zzz-no-such-section'; el.dispatchEvent(new Event('input', { bubbles: true })) } })()`)
    await sleep(300)
    const noMatch = await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-empty-search'); return el && el.offsetParent !== null ? el.textContent.trim() : null })()`)
    ok('no-match hint shown', noMatch !== null, String(noMatch))

    // visual check — captured with search CLEARED so the quick access block
    // and the full tree are visible (the 'zzz' state above hides everything)
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-search'); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) } })()`)
    await sleep(300)
    await send('Page.captureScreenshot', { format: 'png' }).then(r => {
        if (r.result?.data) {
            require('fs').writeFileSync(require('path').join(__dirname, '..', 'test-env', 'quickAccess.png'), Buffer.from(r.result.data, 'base64'))
            console.log('[ok] screenshot → test-env/quickAccess.png')
        }
    })

    console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
