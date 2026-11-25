/** CDP E2E for the Config Manager settings page (4 sub-tabs) and the
 *  IDE-style git browser (3-pane: branch tree | commit graph | diff),
 *  bc instance, port 9233.
 *
 *  Sync scenarios (local smart-http server via scripts/localGitServer.js):
 *  source bootstrap → fetch → commit(ahead) → push → divergence → clean
 *  merge → CONFLICT merge with diff-based resolution → apply → branch
 *  create/switch/push → delete guard → soft reset → update&apply →
 *  graph rendering → dead-port network retry. Non-sync regressions:
 *  sub-tabs, raw editor, native-pill toggles, debug-level log,
 *  cross-window live sync.
 *
 *  Usage: node scripts/configFileTabVerify.js [port] [--github]
 */
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')

const GITHUB_MODE = process.argv.includes('--github')
const PORT = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 9233)
const LOCAL_PORT = 9239
const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}/repo.git`
const OWNER = 'MintSpearCandy'
const REPO = GITHUB_MODE ? fs.readFileSync(path.join(__dirname, '..', 'test-env', 'e2e-repo.txt'), 'utf8').trim() : ''
const CFG = 'D:/Env/TabbyEnv/instances/bc/data/config.yaml'
const GITROOT = path.join(__dirname, '..', 'test-env', 'gitserver', 'root')
const SCRATCH = path.join(__dirname, '..', 'test-env', 'gitserver', 'scratch')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// unique per run — makes assertions immune to config residue from earlier runs
const RUN_VAL = Number(String(Date.now()).slice(-6))
const RUN_VAL_B = RUN_VAL + 1
const RUN_VAL_C = RUN_VAL + 2
const RUN_VAL_A = RUN_VAL + 3
const SRC_NAME = 'E2E ' + RUN_VAL
const pkgFor = (terminalValue, extraName) => JSON.stringify({
    format: 'tabby-config-package', version: 1, kind: 'full',
    exportedAt: new Date().toISOString(), tabbyVersion: '1.0.237',
    modules: {
        terminal: { showRecentProfiles: terminalValue },
        ...(extraName ? { profiles: [{ id: 'bc-e2e-profile', name: extraName, type: 'local', options: {}, group: 'bc-e2e' }] } : {}),
    },
    excluded: [],
}, null, 2)

let failures = 0
const ok = (name, cond, detail = '') => {
    console.log(`[${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' — ' + detail}`)
    if (!cond) failures++
}
const cfgText = () => fs.readFileSync(CFG, 'utf8')

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, {
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        ...opts,
    }, (e, stdout, stderr) => (e && e.code !== 0 ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr })))
})
const gitOp = (args, cwd = SCRATCH) => run('git', args, { cwd })

const ghToken = GITHUB_MODE ? require('child_process').execSync('gh auth token', { encoding: 'utf8' }).trim() : ''

// --------------------------------------------------------- remote helpers ---
async function putContent (branch, content, message) {
    if (!GITHUB_MODE) {
        await gitOp(['fetch', 'origin'])
        const exists = await gitOp(['rev-parse', '--verify', '--quiet', `origin/${branch}`]).then(() => true, () => false)
        const mainExists = await gitOp(['rev-parse', '--verify', '--quiet', 'origin/main']).then(() => true, () => false)
        if (exists) {
            await gitOp(['checkout', '-B', branch, `origin/${branch}`])
        } else if (mainExists) {
            await gitOp(['checkout', '-B', branch, 'origin/main'])
        } else {
            await gitOp(['checkout', '-B', branch])
        }
        fs.writeFileSync(path.join(SCRATCH, 'tabby-config.json'), content)
        await gitOp(['add', '-A'])
        await gitOp(['-c', 'user.name=E2E', '-c', 'user.email=e2e@e2e', 'commit', '-m', message])
        await gitOp(['push', 'origin', branch])
        return
    }
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/tabby-config.json?ref=${branch}`, {
        headers: { Authorization: `token ${ghToken}` },
    }).then(x => x.json())
    const args = ['-X', 'PUT', '-f', `message=${message}`, '-f', `content=${Buffer.from(content).toString('base64')}`, '-f', `branch=${branch}`]
    if (r.sha) {
        args.push('-f', `sha=${r.sha}`)
    }
    require('child_process').execSync(`gh api repos/${OWNER}/${REPO}/contents/tabby-config.json ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')} --jq .commit.sha`, { encoding: 'utf8' })
}

async function remoteContent (branch) {
    if (!GITHUB_MODE) {
        await gitOp(['fetch', 'origin'])
        const { stdout } = await gitOp(['show', `origin/${branch}:tabby-config.json`])
        return stdout
    }
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/tabby-config.json?ref=${branch}`, {
        headers: { Authorization: `token ${ghToken}` },
    }).then(x => x.json())
    return r.content ? Buffer.from(r.content.replace(/\n/g, ''), 'base64').toString('utf8') : null
}

const waitForGitHub = async (timeoutMs = 300000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`https://github.com/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`, {
                headers: { 'User-Agent': 'bc-e2e' },
                signal: AbortSignal.timeout(4000),
            })
            if (r.status < 400) {
                return true
            }
        } catch { /* blocked */ }
        await sleep(5000)
    }
    return false
}

// ------------------------------------------------------------- server ops ---
async function startLocalServer () {
    fs.rmSync(GITROOT, { recursive: true, force: true })
    fs.mkdirSync(GITROOT, { recursive: true })
    await run('git', ['init', '--bare', '-b', 'main', path.join(GITROOT, 'repo.git')])
    await run('git', ['-C', path.join(GITROOT, 'repo.git'), 'config', 'http.receivepack', 'true'])
    const server = spawn(process.execPath, [path.join(__dirname, 'localGitServer.js'), String(LOCAL_PORT), GITROOT], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(r => server.stdout.on('data', r))
    fs.rmSync(SCRATCH, { recursive: true, force: true })
    await run('git', ['clone', LOCAL_URL, SCRATCH])
    await gitOp(['checkout', '-B', 'main'])
    return server
}

async function main () {
    const server = GITHUB_MODE ? null : await startLocalServer()
    try {
        await main_()
    } finally {
        server?.kill()
    }
    console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed')
    process.exit(failures ? 1 : 0)
}

async function main_ () {
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
            throw new Error(String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 500))
        }
        return r.result?.result?.value
    }
    const ROOT = `([...document.querySelectorAll('better-configer')].filter(e => e.offsetParent !== null).slice(-1)[0])`
    const click = sel => evalJs(`${ROOT}?.querySelector('${sel}')?.click()`)
    const evalBool = expr => evalJs(`!!(${expr})`)
    const poll = async (fn, timeoutMs = 20000, interval = 400) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const v = await fn()
            if (v === true || (v && typeof v !== 'object')) return v
            await sleep(interval)
        }
        return null
    }
    const waitUntil = async (fn, timeoutMs, interval = 250) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const v = await fn()
            if (v) return v
            await sleep(interval)
        }
        return null
    }
    const subTab = i => evalJs(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); if (a && a[${i}]) { a[${i}].click(); return 'ok' } return 'missing' })()`)

    // -------------------------------------------- source/browser helpers ---
    /** source tab pill by name text */
    const SRCTAB = name => `(() => [...document.querySelectorAll('.bc-source-tab')].find(t => (t.textContent || '').includes(${JSON.stringify(name)})) )()`
    const selectSource = async (name) => {
        await evalJs(`${SRCTAB(name)}?.click()`)
        return poll(() => evalBool(`(() => { const b = [...document.querySelectorAll('bc-git-browser')].filter(e => e.offsetParent !== null).pop(); return b && b.querySelector('.bc-branch-current') && (b.querySelectorAll('.bc-row').length >= 1) })()`), 30000)
    }
    const BROWSER = `(() => [...document.querySelectorAll('bc-git-browser')].filter(e => e.offsetParent !== null).pop() )()`
    const browserOp = (op) => evalJs(`${BROWSER}?.querySelector('[data-op="${op}"]')?.click()`)
    const browserText = (sel) => evalJs(`(() => { const b = ${BROWSER}; return (b?.querySelector('${sel}') ?? {}).textContent?.replace(/\\s+/g, ' ').trim() ?? null })()`)
    /** click an op button and WAIT for its modal (clicks race re-renders) */
    const opModal = async (op, timeoutMs = 8000) => {
        for (let i = 0; i < 4; i++) {
            // a modal from a previous step must not be mistaken for this op's
            if (await modalInfo()) {
                await evalJs(`(() => { const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop(); const bs = m?.querySelectorAll('.bc-modal-actions button'); if (bs && bs.length) bs[0].click(); return 'ok' })()`)
                await modalGone()
            }
            browserOp(op)
            const m = await waitUntil(() => modalInfo(), Math.min(timeoutMs, 3000))
            if (m) return m
        }
        return null
    }
    const modalInfo = () => evalJs(`(() => {
        const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop()
        if (!m) return null
        return {
            cls: m.className,
            title: (m.querySelector('.bc-modal-title') ?? {}).textContent?.trim() ?? '',
            buttons: [...m.querySelectorAll('.bc-modal-actions button')].map(b => b.textContent.trim()),
        }
    })()`)
    const waitModal = (timeoutMs = 15000) => waitUntil(async () => (await modalInfo()) ?? null, timeoutMs)
    const modalGone = (timeoutMs = 10000) => waitUntil(async () => ((await modalInfo()) === null ? true : null), timeoutMs)
    const clickModalButtonN = (n) => evalJs(`(() => { const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop(); const bs = m?.querySelectorAll('.bc-modal-actions button'); if (bs && bs[${n}]) { bs[${n}].click(); return true } return false })()`)
    const clickModalPrimary = () => evalJs(`(() => { const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop(); const bs = m?.querySelectorAll('.bc-modal-actions button'); if (bs && bs.length) { bs[bs.length - 1].click(); return true } return false })()`)
    const setModalInput = (sel, value) => evalJs(`(() => {
        const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop()
        const el = m?.querySelector('${sel}')
        if (!el) return 'missing'
        el.value = ${JSON.stringify(value)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'ok'
    })()`)
    const setModalSelect = (sel, value) => evalJs(`(() => {
        const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop()
        const el = m?.querySelector('${sel}')
        if (!el) return 'missing'
        el.value = ${JSON.stringify(value)}
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 'ok'
    })()`)
    // the log window is COLLAPSED by default (lines are not in the DOM) —
    // read the service's buffer through the debug handle instead
    const logText = () => evalJs(`(() => {
        try { return (window.__betterConfigerLog?.entries ?? []).map(e => e.message + ' ' + (e.detail ?? '')).join('\\n') } catch { return '' }
    })()`)

    // seed remote main with this run's unique package
    await putContent('main', pkgFor(RUN_VAL, `BC E2E ${RUN_VAL}`), `E2E reseed ${RUN_VAL}`)

    // ---------------------------------------------------------------- load ---
    ok('plugin loaded', !!(await poll(() => evalJs(`!!(window.pluginModules ?? []).some(m => m.pluginName === 'better-configer')`), 30000)))

    await evalJs(`(() => {
        const btns = [...document.querySelectorAll('.tab-bar .btn-tab-bar')]
        btns.find(b => [...b.querySelectorAll('svg path')].some(p => (p.getAttribute('d') ?? '').startsWith('M255.1 512c-56.05')))?.click()
    })()`)
    await sleep(800)
    const pill = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('settings-tab')].filter(e => e.offsetParent !== null)
        const links = [...(tabs[tabs.length - 1] ?? document).querySelectorAll('.nav-pills a')]
        const ours = links.find(a => /Config Manager|配置管理/.test(a.textContent))
        if (!ours) return 'no-pill'
        ours.click()
        return 'clicked'
    })()`)
    ok('config manager page opened', pill === 'clicked')
    await sleep(500)

    // ------------------------------------------------------------ sub-tabs ---
    ok('four sub-tabs present', (await evalJs(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); return a ? a.length : 0 })()`)) === 4)
    await subTab(0)
    ok('manager tab reachable', await evalBool(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); return a && a[0] && a[0].classList.contains('active') })()`))
    ok('sections tree visible on manager tab', await evalBool(`${ROOT}?.querySelector('.bc-nav')`))

    await subTab(1)
    ok('raw editor present (yaml tab)', await evalBool(`${ROOT}?.querySelector('bc-config-yaml-tab textarea.bc-yaml')`))
    await subTab(3)
    ok('native toggles present (settings tab)', (await evalJs(`(() => { const s = ${ROOT}?.querySelector('bc-plugin-settings'); return s ? [...s.querySelectorAll('input[type=checkbox]')].length : 0 })()`)) >= 3)
    await subTab(2)
    ok('sync panel present (sync tab)', await evalBool(`${ROOT}?.querySelector('bc-sync-panel')`))

    // pre-cleanup (config-driven): remove leftover E2E sources; the source
    // tab has an always-visible delete button
    for (let guard = 0; guard < 10; guard++) {
        if (!/name:\s*E2E\b/.test(cfgText())) break
        await evalJs(`(() => {
            const tab = [...document.querySelectorAll('.bc-source-tab')].find(t => /E2E/.test(t.textContent))
            tab?.querySelector('.bc-source-tab-del')?.click()
            return 'ok'
        })()`)
        const m = await waitModal(6000)
        if (!m) { await sleep(1000); continue }
        await clickModalButtonN(0) // Delete (danger button is FIRST)
        await modalGone()
        await sleep(700)
    }
    ok('pre-cleanup removed stale E2E sources', !/name:\s*E2E\b/.test(cfgText()))

    // -------------------------------------------------- raw editor roundtrip ---
    await subTab(1)
    const before = cfgText()
    const ta = '.bc-editors textarea.bc-yaml'
    ok('editor shows config.yaml', (await evalJs(`${ROOT}?.querySelector('${ta}')?.value.includes('terminal')`)) === true)
    await evalJs(`(() => { const el = ${ROOT}.querySelector('${ta}'); el.value = ${JSON.stringify(before + '\nbcE2eMarker: 42\n')}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
    await click('.bc-section-head .btn-primary')
    ok('raw save lands on disk', !!(await poll(() => Promise.resolve(/bcE2eMarker:\s*42/.test(cfgText())))))
    let restored2 = false
    for (let i = 0; i < 10 && !restored2; i++) {
        await evalJs(`(() => { const el = ${ROOT}.querySelector('${ta}'); el.value = ${JSON.stringify(before)}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
        await sleep(250)
        restored2 = !!(await evalJs(`(() => { const b = ${ROOT}?.querySelector('.bc-section-head .btn-primary'); const el = ${ROOT}?.querySelector('${ta}'); return b && !b.disabled && el && !el.value.includes('bcE2eMarker') ? true : false })()`))
    }
    ok('restore input sticks', restored2)
    await click('.bc-section-head .btn-primary')
    ok('raw save restores disk', !!(await poll(() => Promise.resolve(!/bcE2eMarker/.test(cfgText())))))

    // --------------------------------------------------------- hide toggles ---
    await subTab(3)
    const liFile = `document.querySelector('settings-tab li.nav-item[ngbNavItem="config-file"]')`
    const liSync = `[...document.querySelectorAll('settings-tab .nav-pills li.nav-item')].find(li => li.querySelector('a .fa-cloud'))`
    const isHidden = sel => evalJs(`(() => { const el = ${sel}; return el ? getComputedStyle(el).display === 'none' : null })()`)
    const checks = `${ROOT}?.querySelector('bc-plugin-settings')?.querySelectorAll('input[type=checkbox]')`
    await evalJs(`${checks}[0].click()`)
    ok('hide native config-file pill', await poll(async () => (await isHidden(liFile)) === true))
    await evalJs(`${checks}[1].click()`)
    ok('hide native config-sync pill', await poll(async () => (await isHidden(liSync)) === true))
    await evalJs(`${checks}[0].click()`)
    ok('restore native config-file pill', await poll(async () => (await isHidden(liFile)) === false))
    await evalJs(`${checks}[1].click()`)
    ok('toggles restore pills', await poll(async () => (await isHidden(liSync)) === false))

    // ------------------------------------------------------ add sync source ---
    await subTab(2)
    await evalJs(`(() => { const r = ${ROOT}; (r?.querySelector('.bc-sync-add') ?? r?.querySelector('.bc-sync-empty .btn-primary'))?.click(); return 'ok' })()`)
    await sleep(300)
    await evalJs(`(() => { const els = ${ROOT}.querySelectorAll('.bc-sync-editor input[type=text]');
        els[0].value = ${JSON.stringify(SRC_NAME)}; els[0].dispatchEvent(new Event('input', {bubbles:true}));
        els[1].value = ${JSON.stringify(LOCAL_URL)}; els[1].dispatchEvent(new Event('input', {bubbles:true}));
        els[2].value = 'main'; els[2].dispatchEvent(new Event('input', {bubbles:true}));
        els[3].value = 'tabby-config.json'; els[3].dispatchEvent(new Event('input', {bubbles:true}));
        return 'set' })()`)
    await click('.bc-sync-editor-actions .btn-primary')
    ok('source tab appears', !!(await poll(() => evalJs(`!!${SRCTAB(SRC_NAME)}`))))
    ok('source persisted to config.yaml', !!(await poll(() => Promise.resolve(cfgText().includes(SRC_NAME)))))

    // ------------------------------------------- browser: bootstrap + graph ---
    ok('browser selected + bootstrapped', await selectSource(SRC_NAME))
    ok('commit graph rendered (one dot per row + lane segments)', !!(await poll(() => evalJs(`(() => { const b = ${BROWSER}; const rows = b?.querySelectorAll('.bc-row') ?? []; const dots = b?.querySelectorAll('circle.bc-dot') ?? []; const segs = b?.querySelectorAll('path.bc-seg') ?? []; return rows.length >= 1 && dots.length === rows.length && segs.length >= 1 })()`), 30000)))
    ok('graph row shows adopted head', await poll(() => evalJs(`(() => { const b = ${BROWSER}; const rows = [...(b?.querySelectorAll('.bc-row-msg') ?? [])]; return rows.some(r => /(Adopt|E2E reseed)/.test(r.textContent)) })()`)))
    // branch picker (Git Graph style dropdown) lists local + remote
    await evalJs(`(() => { const b = ${BROWSER}; b?.querySelector('.bc-branch-current')?.click(); return 'ok' })()`)
    ok('branch menu lists local + remote', !!(await poll(() => evalJs(`(() => { const b = ${BROWSER}; const names = [...(b?.querySelectorAll('.bc-branch-item-name') ?? [])].map(n => n.textContent.trim()); return names.includes('main') && names.includes('origin/main') })()`))))
    await evalJs(`(() => { document.body.click(); return 'ok' })()`)

    // commit detail: click a graph row (once rows are rendered) → detail panel
    await poll(() => evalJs(`(() => { const b = ${BROWSER}; return (b?.querySelectorAll('.bc-row') ?? []).length >= 1 ? true : null })()`), 15000)
    await evalJs(`(() => { const b = ${BROWSER}; (b?.querySelectorAll('.bc-row') ?? [])[0]?.click(); return 'ok' })()`)
    ok('commit detail panel opens', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return b?.querySelector('.bc-detail-bar-msg') ?? null })()`).then(v => !!v)))

    // The detail pane must show the diff of the commit that is SELECTED, and
    // must not get stuck in "Loading diff…" when rows are clicked faster than
    // the engine resolves (stale-response race — previously 18/20 rapid
    // double-clicks left the pane loading forever).
    const detailState = () => evalJs(`(() => {
        const b = ${BROWSER}; const d = b?.querySelector('.bc-detail')
        return {
            selectedHash: (b?.querySelector('.bc-row.selected .bc-row-hash')?.textContent ?? '').trim(),
            detailHash: (d?.querySelector('.bc-detail-bar-hash')?.textContent ?? '').trim(),
            loading: !!d?.querySelector('.bc-detail-loading'),
            lines: d?.querySelectorAll('.bc-diff-line').length,
            noDiff: !!d?.querySelector('.bc-detail-nodiff'),
        }
    })()`)
    // a commit with a real config change must render line-level diff lines
    const withDiff = await evalJs(`(() => { const rows = [...document.querySelectorAll('bc-git-browser .bc-row')]; const i = rows.findIndex(r => /update config package|Adopt|E2E reseed/.test(r.querySelector('.bc-row-msg')?.textContent ?? '')); return i < 0 ? 1 : i })()`)
    await evalJs(`(() => { document.querySelectorAll('bc-git-browser .bc-row')[${withDiff}].click(); return 'ok' })()`)
    ok('detail renders line-level diff for a config commit', await poll(() => detailState().then(st => !st.loading && (st.lines > 0 || st.noDiff) ? true : null), 8000))

    // fetch
    browserOp('fetch')
    await sleep(2500)

    // ------------------------------------------- commit + push ---
    await subTab(1)
    await evalJs(`(() => { const el = ${ROOT}.querySelector('${ta}'); el.value = ${JSON.stringify(cfgText() + '\nbcE2ePush: ok\n')}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
    await click('.bc-section-head .btn-primary')
    await poll(() => Promise.resolve(/bcE2ePush:\s*ok/.test(cfgText())))
    await subTab(2)
    let m = await opModal('commit')
    ok('commit modal shown with diff', !!m && /bc-modal-commit/.test(m.cls), JSON.stringify(m))
    ok('commit diff lists changed section', !!(await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-commit')].filter(e => e.offsetParent !== null).pop(); return mm && /bcE2ePush/.test(mm.textContent) })()`)))
    ok('commit diff has line-level add', !!(await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-commit')].filter(e => e.offsetParent !== null).pop(); return mm && mm.querySelector('.bc-diff-line.add') })()`)))
    await setModalInput('.bc-modal-field input[type=text]', `E2E commit ${RUN_VAL}`)
    await clickModalPrimary()
    await modalGone()
    ok('commit recorded, ahead badge', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return b?.querySelector('.bc-branch-ab .ahead') })()`).then(v => !!v)))

    m = await opModal('push')
    ok('push modal shows outgoing commit', !!m && /bc-modal-push/.test(m.cls) && !!(await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-push')].filter(e => e.offsetParent !== null).pop(); return mm && /E2E commit/.test(mm.textContent) })()`)), JSON.stringify(m))
    await clickModalPrimary()
    await modalGone()
    ok('push lands on remote', !!(await poll(async () => (await remoteContent('main')).includes('bcE2ePush'), 30000)))
    ok('ahead badge cleared', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return !b?.querySelector('.bc-branch-ab .ahead') })()`)))

    // --------------------------------------- divergence + clean merge ---
    await putContent('main', JSON.stringify({
        format: 'tabby-config-package', version: 1, kind: 'full',
        exportedAt: new Date().toISOString(), tabbyVersion: '1.0.237',
        modules: {
            terminal: { showRecentProfiles: RUN_VAL }, // == base (untouched)
            profiles: [{ id: 'bc-e2e-profile', name: `BC E2E ${RUN_VAL}`, type: 'local', options: {}, group: 'bc-e2e' }],
            bcE2eRemoteSide: RUN_VAL_B, // brand-new section → clean merge
        },
        excluded: [],
    }, null, 2), `remote diverge ${RUN_VAL_B}`)
    browserOp('fetch')
    ok('behind badge after divergence', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return b?.querySelector('.bc-branch-ab .behind') })()`).then(v => !!v)))
    m = await opModal('merge')
    ok('merge modal shown', !!m && /bc-modal-merge/.test(m.cls), JSON.stringify(m))
    await setModalSelect('select', 'origin/main')
    await clickModalPrimary()
    await modalGone()
    ok('clean merge committed (log)', !!(await poll(() => logText().then(t => /merged origin\/main/.test(t) ? true : null))))

    // Rapid double clicks across different rows. The assertion is about
    // LATENCY, not the eventual state: the pre-fix race left the pane in
    // "Loading diff…" until some unrelated event re-ran change detection, so
    // a generous wait would always "pass" once later test steps poked the
    // page. The engine resolves a selection in ~8 ms; anything not settled
    // well inside this window is the bug.
    let settled = 0
    const rounds = 8
    const SETTLE_MS = 150
    for (let r = 0; r < rounds; r++) {
        const n = await evalJs(`document.querySelectorAll('bc-git-browser .bc-row').length`)
        if (n < 3) { settled++; continue } // not enough history yet
        const a = 1 + (r % (n - 1))
        const b2 = 1 + ((r + 1) % (n - 1))
        if (a === b2) { settled++; continue }
        await evalJs(`(() => { const rows = document.querySelectorAll('bc-git-browser .bc-row'); rows[${a}].click(); rows[${b2}].click(); return 'ok' })()`)
        // ONE sample, taken inside the window — no polling that could mask a stall
        await sleep(SETTLE_MS)
        const st = await detailState()
        if (!st.loading && st.selectedHash === st.detailHash && st.selectedHash !== '' && (st.lines > 0 || st.noDiff)) settled++
    }
    ok(`rapid ${rounds}x double-click settles within ${SETTLE_MS}ms each`, settled === rounds, `${settled}/${rounds}`)

    // --------------------------------------------- conflict merge + resolve ---
    await subTab(1)
    for (let i = 0; i < 10; i++) {
        await evalJs(`(() => { const el = ${ROOT}.querySelector('${ta}'); el.value = ${JSON.stringify(cfgText() + '\nbcE2eLocalSide: ' + RUN_VAL_C + '\n')}; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
        await sleep(250)
        const sticks = !!(await evalJs(`(() => { const b = ${ROOT}?.querySelector('.bc-section-head .btn-primary'); const el = ${ROOT}?.querySelector('${ta}'); return b && !b.disabled && el && el.value.includes('bcE2eLocalSide') ? true : false })()`))
        if (sticks) break
    }
    await click('.bc-section-head .btn-primary')
    await poll(() => Promise.resolve(new RegExp(`bcE2eLocalSide:\\s*${RUN_VAL_C}`).test(cfgText())))
    await subTab(2)
    m = await opModal('commit')
    await setModalInput('.bc-modal-field input[type=text]', 'local side change')
    await clickModalPrimary()
    await modalGone()
    await sleep(500)
    const conflictContent = JSON.stringify({
        format: 'tabby-config-package', version: 1, kind: 'full',
        exportedAt: new Date().toISOString(), tabbyVersion: '1.0.237',
        modules: { terminal: { showRecentProfiles: RUN_VAL_B }, bcE2eLocalSide: RUN_VAL_C + 1 },
        excluded: [],
    }, null, 2)
    await putContent('main', conflictContent, `conflict commit ${RUN_VAL_C}`)
    browserOp('fetch')
    await poll(() => evalJs(`(() => { const b = ${BROWSER}; return b?.querySelector('.bc-branch-ab .behind') ?? null })()`).then(v => !!v), 20000)
    await sleep(1500) // toolbar re-render settle
    m = await opModal('merge')
    await setModalSelect('select', 'origin/main')
    await clickModalPrimary()
    const conf = await waitUntil(async () => {
        const info = await modalInfo()
        return info && /bc-modal-conflicts/.test(info.cls) ? info : null
    }, 25000)
    if (!conf) {
        const tail = String(await logText())
        console.log('      [cf] log tail:', tail.split('\n').slice(-4).join(' | ').slice(0, 300))
    }
    ok('conflict modal shown with side diff', !!conf && !!(await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-conflicts')].filter(e => e.offsetParent !== null).pop(); return mm && /bcE2eLocalSide/.test(mm.textContent) && mm.querySelector('.bc-diff-line') })()`)), JSON.stringify(conf))
    if (conf) {
        await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-conflicts')].filter(e => e.offsetParent !== null).pop(); [...mm.querySelectorAll('.bc-conflict-row')].forEach(row => { const btns = row.querySelectorAll('.bc-conflict-choices button'); if (btns[1]) btns[1].click() }); return 'ok' })()`)
        await clickModalPrimary()
        await modalGone()
        ok('merge commit after resolution (log)', !!(await poll(() => logText().then(t => /merge committed/.test(t) ? true : null))))
    }

    // ---------------------------------------------------------- apply to config ---
    m = await opModal('apply')
    ok('apply modal shown with diff', !!m && /bc-modal-apply/.test(m.cls), JSON.stringify(m))
    await clickModalPrimary()
    await modalGone()
    ok('apply writes resolved value to config', !!(await poll(() => Promise.resolve(new RegExp(`bcE2eLocalSide:\\s*${RUN_VAL_C + 1}`).test(cfgText())))))

    // ---------------------------------------------------------- update & apply ---
    // (on MAIN, before the branch/reset section changes the workspace state)
    await putContent('main', pkgFor(RUN_VAL_A, `BC E2E ${RUN_VAL_A}`), `machine-a style update ${RUN_VAL_A}`)
    browserOp('update')
    ok('update&apply lands new value', !!(await poll(() => Promise.resolve(new RegExp(`showRecentProfiles:\\s*${RUN_VAL_A}`).test(cfgText())), 60000)))

    // --------------------------------------------------- branch + soft reset ---
    // open the branch manager from the picker ("+ New branch name")
    const openBranchManager = async () => {
        for (let i = 0; i < 4; i++) {
            if (await modalInfo()) break
            await evalJs(`(() => { const b = ${BROWSER}; if (!b?.querySelector('.bc-branch-menu')) b?.querySelector('.bc-branch-current')?.click(); return 'ok' })()`)
            await sleep(300)
            await evalJs(`(() => { const b = ${BROWSER}; [...(b?.querySelectorAll('.bc-branch-menu-title .bc-link-btn') ?? [])][0]?.click(); return 'ok' })()`)
            if (await waitUntil(() => modalInfo(), 3000)) break
        }
        return modalInfo()
    }
    m = await openBranchManager()
    ok('branch modal shown', !!m && /bc-modal-branch/.test(m.cls), JSON.stringify(m))
    await setModalInput('.bc-modal-field input[type=text]', 'feature-x')
    await setModalSelect('select', 'origin/main')
    await clickModalPrimary()
    await modalGone()
    await sleep(800)
    await evalJs(`(() => { const b = ${BROWSER}; b?.querySelector('.bc-branch-current')?.click(); return 'ok' })()`)
    ok('branch created and listed in picker', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return [...(b?.querySelectorAll('.bc-branch-item-name') ?? [])].some(n => n.textContent.trim() === 'feature-x') })()`)))
    // the picker menu is still open — click feature-x to switch to it
    await evalJs(`(() => { const b = ${BROWSER}; const item = [...(b?.querySelectorAll('.bc-branch-item') ?? [])].find(r => (r.querySelector('.bc-branch-item-name')?.textContent ?? '').trim() === 'feature-x'); item?.click(); return 'ok' })()`)
    ok('switched to feature-x (branch picker shows it)', await poll(() => evalJs(`(() => { const b = ${BROWSER}; return (b?.querySelector('.bc-branch-current-name')?.textContent ?? '').trim() === 'feature-x' })()`)))
    await sleep(1500) // let the browser reload settle after the switch
    // soft reset to an earlier commit from the bottom detail bar
    await poll(() => evalJs(`(() => { const b = ${BROWSER}; return (b?.querySelectorAll('.bc-row') ?? []).length >= 2 ? true : null })()`), 15000)
    let resetOpened = false
    for (let i = 0; i < 5 && !resetOpened; i++) {
        await evalJs(`(() => { const b = ${BROWSER}; const rows = [...(b?.querySelectorAll('.bc-row') ?? [])]; if (rows[1]) rows[1].click(); return 'ok' })()`)
        await sleep(1500)
        resetOpened = !!(await evalJs(`(() => { const b = ${BROWSER}; const bar = b?.querySelector('.bc-detail-bar'); return bar && [...bar.querySelectorAll('.bc-link-btn')].some(x => /Reset here|重置到此/.test(x.textContent)) ? true : false })()`))
    }
    ok('reset button appears in detail', resetOpened)
    await evalJs(`(() => { const b = ${BROWSER}; const bar = b?.querySelector('.bc-detail-bar'); [...(bar?.querySelectorAll('.bc-link-btn') ?? [])].find(x => /Reset here|重置到此/.test(x.textContent))?.click(); return 'ok' })()`)
    const resetModal = await waitModal(8000)
    ok('reset confirm modal shown', !!resetModal && /bc-modal-reset/.test(resetModal.cls))
    await clickModalPrimary()
    await modalGone()
    ok('soft reset recorded (log)', !!(await poll(() => logText().then(t => /reset feature-x to/.test(t) ? true : null))))
    // delete guard: the CURRENT branch row has no delete button
    m = await openBranchManager()
    const delBlocked = await evalJs(`(() => { const mm = [...document.querySelectorAll('.bc-modal-branch')].filter(e => e.offsetParent !== null).pop(); const row = [...mm.querySelectorAll('.bc-branch-row')].find(r => /feature-x/.test(r.textContent) && /(current|当前)/.test(r.textContent)); return row ? row.querySelectorAll('.bc-branch-actions button').length : -1 })()`)
    ok('current branch has no delete button', delBlocked === 0, String(delBlocked))
    await clickModalButtonN(0) // cancel

    // ------------------------------------------------------- debug-level log ---
    const logLevels = async () => evalJs(`(() => { try { return (window.__betterConfigerLog?.entries ?? []).map(e => e.level) } catch { return [] } })()`)
    const levels = await logLevels()
    ok('debug lines recorded by the engine', levels.filter(l => l === 'debug').length >= 3, JSON.stringify(levels.reduce((m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {})))
    // the window is collapsed by default; expanding it shows the lines and the
    // debug toggle filters them
    await evalJs(`(() => { const r = ${ROOT}; r?.querySelector('.bc-sync-log-head')?.click(); return 'ok' })()`)
    ok('log window expands', await poll(() => evalBool(`(() => { const r = ${ROOT}; return (r?.querySelectorAll('.bc-sync-log-line') ?? []).length >= 1 })()`)))
    const dbgLine = `(() => { const r = ${ROOT}; return [...(r?.querySelectorAll('.bc-sync-log-line.debug') ?? [])][0] ?? null })()`
    const dbgShown = () => evalJs(`(() => { const el = ${dbgLine}; return el ? getComputedStyle(el).display !== 'none' : null })()`)
    ok('debug lines hidden by default', await poll(async () => (await dbgShown()) === false))
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-sync-log-head input[type=checkbox]'); if (el && !el.checked) el.click(); return 'ok' })()`)
    ok('debug toggle shows them', await poll(async () => (await dbgShown()) === true))
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-sync-log-head input[type=checkbox]'); if (el && el.checked) el.click(); return 'ok' })()`)
    await evalJs(`(() => { const r = ${ROOT}; r?.querySelector('.bc-sync-log-head')?.click(); return 'ok' })()`)

    // ------------------------------------------------ cross-window live sync ---
    const XWIN = `bcXwin${RUN_VAL}`
    // let the app's pending saves settle first — a delayed app save would
    // overwrite our external write and the marker would never be seen
    await sleep(2500)
    for (let attempt = 0; attempt < 3; attempt++) {
        let withMarker = cfgText().replace(/^language:.*\n/m, `language: null\n${XWIN}: 1\n`)
        if (!withMarker.includes(XWIN)) {
            withMarker = cfgText() + `\n${XWIN}: 1\n`
        }
        fs.writeFileSync(CFG, withMarker, 'utf8')
        await sleep(600)
        if (cfgText().includes(XWIN)) break // marker survived the save race
    }
    const xwinSeen = await poll(() => evalJs(`(() => { try { return window.__betterConfigerMap.rawStore()[${JSON.stringify(XWIN)}] !== undefined ? true : null } catch (e) { return 'err ' + e.message } })()`), 8000)
    if (!xwinSeen) {
        console.log('      [xwin] marker on disk:', withMarker.includes(XWIN), '| rawStore keys:', await evalJs(`(() => { try { return Object.keys(window.__betterConfigerMap.rawStore()).filter(k => k.startsWith('bcX')).join(',') || '(none)' } catch (e) { return 'err ' + e.message } })()`))
    }
    ok('external config write picked up live', xwinSeen === true)
    fs.writeFileSync(CFG, cfgText().replace(new RegExp(`^${XWIN}: 1.*\\n`, 'm'), ''), 'utf8')
    ok('external config removal picked up', !!(await poll(() => evalJs(`(() => { try { return window.__betterConfigerMap.rawStore()[${JSON.stringify(XWIN)}] === undefined ? true : null } catch { return null } })()`), 8000)))

    // ------------------------------------------------------------- cleanup ---
    ok('sync log file persisted', await (async () => {
        try {
            const f = 'D:/Env/TabbyEnv/instances/bc/data/better-configer/sync.log'
            const text = fs.readFileSync(f, 'utf8')
            return /pushed|merged/.test(text) && /DEBUG/.test(text)
        } catch {
            return false
        }
    })())

    // dead-port retry source
    await evalJs(`(() => { const r = ${ROOT}; (r?.querySelector('.bc-sync-add') ?? r?.querySelector('.bc-sync-empty .btn-primary'))?.click(); return 'ok' })()`)
    await sleep(300)
    await evalJs(`(() => { const els = ${ROOT}.querySelectorAll('.bc-sync-editor input[type=text]');
        els[0].value = ${JSON.stringify('E2E dead ' + RUN_VAL)}; els[0].dispatchEvent(new Event('input', {bubbles:true}));
        els[1].value = 'http://127.0.0.1:9/repo.git'; els[1].dispatchEvent(new Event('input', {bubbles:true}));
        els[2].value = 'main'; els[2].dispatchEvent(new Event('input', {bubbles:true}));
        els[3].value = 'tabby-config.json'; els[3].dispatchEvent(new Event('input', {bubbles:true}));
        return 'set' })()`)
    await click('.bc-sync-editor-actions .btn-primary')
    await poll(() => evalJs(`!!${SRCTAB('E2E dead ' + RUN_VAL)}`))
    browserOp('fetch')
    ok('network retries logged', !!(await poll(() => logText().then(t => (t.match(/retrying/g) ?? []).length >= 2 ? true : null), 40000)))
    ok('final network error logged with hint', !!(await poll(() => logText().then(t => /E2E dead .*:.*(ECONNREFUSED|connect)/.test(t) ? true : null), 20000)))

    // delete our sources (config end-state driven)
    let cleanupOk = false
    for (let guard = 0; guard < 10 && !cleanupOk; guard++) {
        cleanupOk = !/name:\s*E2E\b/.test(cfgText())
        if (cleanupOk) break
        await evalJs(`(() => {
            const tab = [...document.querySelectorAll('.bc-source-tab')].find(t => /E2E/.test(t.textContent))
            tab?.querySelector('.bc-source-tab-del')?.click()
            return 'ok'
        })()`)
        const mm = await waitModal(6000).catch(() => null)
        if (mm) {
            await clickModalButtonN(0) // Delete (danger first)
            await modalGone()
        }
        await sleep(800)
    }
    ok('E2E sources cleaned from UI + config', cleanupOk && !/name:\s*E2E\b/.test(cfgText()))
}

main().catch(e => { console.error(e); process.exit(1) })
