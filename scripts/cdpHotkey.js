/** Send a key chord via CDP Input.dispatchKeyEvent to the main window.
 *  Follows the tabby-debug skill: a sacrificial F13 rawKeyDown first burns the
 *  hotkey engine's timestamp-dedup slot, so the real chord lands.
 *  Usage: node cdpHotkey.js <port> <Key> <modifiers>   e.g. node cdpHotkey.js 9231 b 3   (3 = ctrl|alt) */
const PORT = Number(process.argv[2] || 9231)
const KEY = process.argv[3] || 'b'
const MODS = Number(process.argv[4] || 0)

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('no main window')
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) {
            pend.get(m.id)(m)
            pend.delete(m.id)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

    // sacrificial unbound key to burn the dedup slot
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    await new Promise(r => setTimeout(r, 120))

    const common = { key: KEY, code: `Key${KEY.toUpperCase()}`, windowsVirtualKeyCode: KEY.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: KEY.toUpperCase().charCodeAt(0), modifiers: MODS }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    console.log(`sent ${KEY} mods=${MODS}`)
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
