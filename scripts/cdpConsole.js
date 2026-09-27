/** Attach CDP, reload the main window, capture renderer console output for N ms.
 *  Usage: node cdpConsole.js [port] [waitMs] [filterRegex] */
const PORT = Number(process.argv[2] || 9231)
const WAIT = Number(process.argv[3] || 8000)
const FILTER = process.argv[4] ? new RegExp(process.argv[4], 'i') : null

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('no main window')
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const send = (method, params = {}) => new Promise(r => {
        const i = ++id
        const onMsg = ev => {
            const m = JSON.parse(ev.data)
            if (m.id === i) {
                ws.removeEventListener('message', onMsg)
                r(m)
            }
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id: i, method, params }))
    })
    const lines = []
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            lines.push(`[${m.params.type}] ${text}`)
        }
        if (m.method === 'Runtime.exceptionThrown') {
            lines.push(`[exception] ${m.params.exceptionDetails?.text} ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? ''}`)
        }
    })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.reload', { ignoreCache: true })
    await new Promise(r => setTimeout(r, WAIT))
    const shown = FILTER ? lines.filter(l => FILTER.test(l)) : lines
    console.log(shown.join('\n') || '(no matching console output)')
    console.log(`--- total console lines: ${lines.length}`)
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
