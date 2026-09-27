/** Evaluate an expression in the main window while capturing renderer
 *  console output (e.g. hotkey-engine logs) for a few seconds around it.
 *  Usage: node cdpEvalWatch.js <port> <waitMs> <expression> [filterRegex] */
const PORT = Number(process.argv[2] || 9231)
const WAIT = Number(process.argv[3] || 3000)
const EXPR = process.argv[4] || '1+1'
const FILTER = process.argv[5] ? new RegExp(process.argv[5], 'i') : null

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

    const lines = []
    const onMsg = ev => {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            lines.push(`[${m.params.type}] ${text}`)
        }
    }
    ws.addEventListener('message', onMsg)
    await send('Runtime.enable')
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
    console.log('eval result:', JSON.stringify(r.result?.result?.value ?? r.result?.result?.description))
    await new Promise(r2 => setTimeout(r2, WAIT))
    ws.removeEventListener('message', onMsg)
    const shown = FILTER ? lines.filter(l => FILTER.test(l)) : lines
    console.log(shown.slice(0, 40).join('\n') || '(no console output)')
    console.log(`--- total lines: ${lines.length}`)
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
