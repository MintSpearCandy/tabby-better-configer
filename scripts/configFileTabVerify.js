/** CDP E2E for the Config Manager settings page and its four sub-tabs
 *  (Sections / config.yaml / Git sync / Settings), bc instance, port 9233.
 *  Covers: page + sub-tab registration, raw config.yaml editor round-trip,
 *  native-tab hiding toggles (CSS), and the full git sync flow — add source /
 *  pull & merge / push / force-push-after-rejection / branch switch.
 *
 *  Default mode serves a LOCAL bare repo over smart-http
 *  (scripts/localGitServer.js, git http-backend shim on 127.0.0.1:9239) —
 *  deterministic, no network. `--github` switches to a live GitHub repo and
 *  waits out github.com:443 blocking windows.
 *
 *  Sub-tabs render exclusively (*ngIf), so most element queries can scope to
 *  the page shell (`better-configer`) — just make sure the right sub-tab is
 *  active first. Confirm modals are the plugin's own `.bc-modal` overlay.
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
const RUN_VAL_A = RUN_VAL + 1
const pkgFor = (recentValue, profileName) => JSON.stringify({
    format: 'tabby-config-package', version: 1, kind: 'full',
    exportedAt: new Date().toISOString(), tabbyVersion: '1.0.237',
    modules: {
        terminal: { showRecentProfiles: recentValue },
        profiles: [{ id: 'bc-e2e-profile', name: profileName, type: 'local', options: {}, group: 'bc-e2e' }],
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

/** github.com:443 is intermittently blocked on this machine (api.github.com
 *  is not). In --github mode, wait for a reachable window. */
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
            console.log(`  github.com → HTTP ${r.status}, waiting for a window...`)
        } catch {
            console.log('  github.com unreachable, waiting for a window...')
        }
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
    await new Promise(r => server.stdout.on('data', r)) // ready line
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
    // The ONE settings page; sub-tabs render exclusively so queries below can
    // scope to the shell as long as the right sub-tab is active.
    const ROOT = `([...document.querySelectorAll('better-configer')].filter(e => e.offsetParent !== null).slice(-1)[0])`
    const click = sel => evalJs(`${ROOT}?.querySelector('${sel}')?.click()`)
    // NOTE: elements/NodeLists do not survive returnByValue — always compute
    // booleans/counts INSIDE the page expression
    const evalBool = expr => evalJs(`!!(${expr})`)
    const setInput = (sel, value) => evalJs(`(() => {
        const el = ${ROOT}?.querySelector('${sel}')
        if (!el) return 'missing ' + '${sel}'
        el.value = ${JSON.stringify(value)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'ok'
    })()`)
    const poll = async (fn, timeoutMs = 20000, interval = 400) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const v = await fn()
            if (v === true || (v && typeof v !== 'object')) return v
            await sleep(interval)
        }
        return null
    }
    /** sub-tabs: 0=Sections 1=config.yaml 2=Git sync 3=Settings */
    const subTab = i => evalJs(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); if (a && a[${i}]) { a[${i}].click(); return 'ok' } return 'missing' })()`)
    const subTabLabel = i => evalJs(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); return a && a[${i}] ? a[${i}].textContent.trim() : null })()`)

    // ------------------------------------------------ in-app modal helpers ---
    const LASTCARD = `(() => { const cards = ${ROOT}?.querySelectorAll('.bc-sync-source'); return cards ? cards[cards.length - 1] : null })()`
    const modalInfo = () => evalJs(`(() => {
        const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop()
        if (!m) return null
        return {
            title: (m.querySelector('.bc-modal-title') ?? {}).textContent?.trim() ?? '',
            detail: (m.querySelector('.bc-modal-detail') ?? {}).textContent?.trim().split('\\n')[0] ?? '',
            buttons: [...m.querySelectorAll('.bc-modal-actions button')].map(b => b.textContent.trim()),
        }
    })()`)
    const waitUntil = async (fn, timeoutMs, interval = 250) => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const v = await fn()
            if (v) return v
            await sleep(interval)
        }
        return null
    }
    const waitModal = (timeoutMs = 15000) => waitUntil(async () => (await modalInfo()) ?? null, timeoutMs)
    const modalGone = (timeoutMs = 10000) => waitUntil(async () => ((await modalInfo()) === null ? true : null), timeoutMs)
    const clickModalButton = i => evalJs(`(() => {
        const m = [...document.querySelectorAll('.bc-modal')].filter(e => e.offsetParent !== null).pop()
        const bs = m?.querySelectorAll('.bc-modal-actions button')
        if (bs && bs[${i}]) { bs[${i}].click(); return true }
        return false
    })()`)
    /** Click a source action, wait for ITS modal, press button `buttonIndex`.
     *  Retries when the synthetic click races Angular's row re-render. */
    const act = async (actionIndex, buttonIndex, titleRe, tries = 6) => {
        for (let i = 0; i < tries; i++) {
            await evalJs(`(() => { const bs = ${LASTCARD}?.querySelectorAll('.bc-sync-source-actions .btn'); if (bs && bs[${actionIndex}]) { bs[${actionIndex}].click(); return 'ok' } return 'missing' })()`)
            const m = await waitModal(6000)
            if (m && titleRe.test(m.title)) {
                await clickModalButton(buttonIndex)
                await modalGone()
                return m.title
            }
            if (m) { // stray modal — cancel it and retry
                await clickModalButton(m.buttons.length - 1)
                await modalGone()
            }
            await sleep(600)
        }
        return null
    }
    const logText = () => evalJs(`(() => {
        const lines = [...(${ROOT})?.querySelectorAll('.bc-sync-log-line') ?? []].map(l => l.textContent)
        return lines.join('\\n')
    })()`)

    // seed remote main with this run's unique package
    await putContent('main', pkgFor(RUN_VAL, `BC E2E ${RUN_VAL}`), `E2E reseed ${RUN_VAL}`)

    // ---------------------------------------------------------------- load ---
    ok('plugin loaded', !!(await poll(() => evalJs(`!!(window.pluginModules ?? []).some(m => m.pluginName === 'better-configer')`), 30000)))

    // open settings and switch to our page
    await evalJs(`(() => {
        const btns = [...document.querySelectorAll('.tab-bar .btn-tab-bar')]
        btns.find(b => [...b.querySelectorAll('svg path')].some(p => (p.getAttribute('d') ?? '').startsWith('M255.1 512c-56.05')))?.click()
    })()`)
    await sleep(800)
    const pill = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('settings-tab')].filter(e => e.offsetParent !== null)
        const links = [...(tabs[tabs.length - 1] ?? document).querySelectorAll('.nav-pills a')]
        const ours = links.find(a => /Config Manager|配置管理/.test(a.textContent))
        if (!ours) return 'no-pill: ' + links.map(l => l.textContent.trim()).join('|')
        ours.click()
        return 'clicked'
    })()`)
    ok('config manager page opened', pill === 'clicked', String(pill))
    await sleep(500)

    // ------------------------------------------------------------ sub-tabs ---
    ok('four sub-tabs present', (await evalJs(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); return a ? a.length : 0 })()`)) === 4)
    console.log('      labels:', await subTabLabel(0), '/', await subTabLabel(1), '/', await subTabLabel(2), '/', await subTabLabel(3))
    // the settings page (and its sub-tab state) SURVIVES between runs — always
    // switch explicitly instead of relying on the default
    await subTab(0)
    ok('manager tab reachable', await evalBool(`(() => { const a = ${ROOT}?.querySelectorAll('.bc-tabs a'); return a && a[0] && a[0].classList.contains('active') })()`))
    ok('sections tree visible on manager tab', await evalBool(`${ROOT}?.querySelector('.bc-nav')`))

    await subTab(1)
    ok('raw editor present (yaml tab)', await evalBool(`${ROOT}?.querySelector('bc-config-yaml-tab textarea.bc-yaml')`))
    await subTab(3)
    ok('native toggles present (settings tab)', (await evalJs(`(() => { const s = ${ROOT}?.querySelector('bc-plugin-settings'); return s ? [...s.querySelectorAll('input[type=checkbox]')].length : 0 })()`)) >= 2)
    await subTab(2)
    ok('sync panel present (sync tab)', await evalBool(`${ROOT}?.querySelector('bc-sync-panel')`))

    // pre-cleanup: remove only OUR leftover sources (any 'E2E' name) — a
    // user-configured source on this instance must survive the run
    for (let guard = 0; guard < 6; guard++) {
        const idx = await evalJs(`(() => { const cards = [...(${ROOT})?.querySelectorAll('.bc-sync-source') ?? []]; return cards.findIndex(c => /E2E/.test(c.textContent)) })()`)
        if (idx === null || idx < 0) break
        console.log('  (pre-cleanup: deleting leftover E2E source)')
        await evalJs(`(() => { const cards = [...(${ROOT})?.querySelectorAll('.bc-sync-source')]; const bs = cards[${idx}]?.querySelectorAll('.bc-sync-source-actions .btn'); if (bs && bs[3]) bs[3].click(); return 'ok' })()`)
        const m = await waitModal(6000)
        if (!m) break
        await clickModalButton(0) // Delete
        await modalGone()
        await sleep(600)
    }

    // -------------------------------------------------- raw editor roundtrip ---
    await subTab(1)
    const before = cfgText()
    const ta = '.bc-editors textarea.bc-yaml'
    ok('editor shows config.yaml', (await evalJs(`${ROOT}?.querySelector('${ta}')?.value.includes('terminal')`)) === true)
    await setInput(ta, before + '\nbcE2eMarker: 42\n')
    await click('.bc-section-head .btn-primary') // Save and apply
    ok('raw save lands on disk', !!(await poll(() => Promise.resolve(/bcE2eMarker:\s*42/.test(cfgText())))))
    // The changed$ reload races any immediate re-edit (it resets the textarea
    // and clears dirty, making the save click a no-op). Re-assert our input
    // until it sticks: textarea lacks the marker AND the save button is
    // enabled — then click.
    let restored2 = false
    for (let i = 0; i < 10 && !restored2; i++) {
        await setInput(ta, before)
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
    // restore one at a time — both writes are read-modify-write on the whole
    // config, so firing them back-to-back races and loses one update
    await evalJs(`${checks}[0].click()`)
    ok('restore native config-file pill', await poll(async () => (await isHidden(liFile)) === false))
    await evalJs(`${checks}[1].click()`)
    ok('toggles restore pills', await poll(async () => (await isHidden(liSync)) === false))

    // --------------------------------------------------------- add source ---
    await subTab(2)
    await click('.bc-sync-head-actions .btn-primary') // Add source
    await sleep(200)
    await evalJs(`(() => { const els = ${ROOT}.querySelectorAll('.bc-sync-editor input[type=text]');
        els[0].value = 'E2E local'; els[0].dispatchEvent(new Event('input', {bubbles:true}));
        els[1].value = ${JSON.stringify(LOCAL_URL)}; els[1].dispatchEvent(new Event('input', {bubbles:true}));
        els[2].value = 'main'; els[2].dispatchEvent(new Event('input', {bubbles:true}));
        els[3].value = 'tabby-config.json'; els[3].dispatchEvent(new Event('input', {bubbles:true}));
        return 'set' })()`)
    await click('.bc-sync-editor-actions .btn-primary') // Save source
    ok('source card appears', !!(await poll(() => evalBool(`${ROOT}?.querySelector('.bc-sync-source')`))))
    ok('source persisted to config.yaml', !!(await poll(() => Promise.resolve(cfgText().includes('E2E local')))))

    // ------------------------------------------------------------- pull main ---
    if (GITHUB_MODE) {
        ok('github.com reachable (window)', await waitForGitHub())
    }
    const pullTitle = await act(0, 0, /Pull config package|拉取配置包/)
    ok('pull confirm modal shown', !!pullTitle)
    ok('pull merge applies package', !!(await poll(() => Promise.resolve(new RegExp(`showRecentProfiles:\\s*${RUN_VAL}\\b`).test(cfgText())), 60000)))
    ok('pull id-merges profiles', new RegExp(`name:\\s*BC E2E ${RUN_VAL}\\b`).test(cfgText()))
    ok('lastPull recorded', await poll(() => evalJs(`(() => { const c = ${LASTCARD}; const first = c?.querySelector('.bc-sync-source-last span'); return !!first && /Last pull|上次拉取/.test(first.textContent) && !/never|从未/.test(first.textContent) })()`)))
    ok('sync log records the pull', !!(await poll(() => logText().then(t => /applied package/.test(t) ? true : null))))

    // ------------------------------------------------- debug-level logging ---
    // debug lines are logged regardless, but hidden by default (CSS filter)
    const dbgLine = `document.querySelector('.bc-sync-log-line.debug')`
    const dbgShown = () => evalJs(`(() => { const el = ${dbgLine}; return el ? getComputedStyle(el).display !== 'none' : null })()`)
    ok('debug lines exist (pull produced them)', !!(await poll(() => evalBool(dbgLine))))
    ok('debug lines hidden by default', await poll(async () => (await dbgShown()) === false))
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-sync-log-head input[type=checkbox]'); if (el) el.click(); return 'ok' })()`)
    ok('debug toggle shows them', await poll(async () => (await dbgShown()) === true))
    ok('debug request lines logged', !!(await poll(() => evalJs(`(() => { const lines = [...document.querySelectorAll('.bc-sync-log-line.debug')].map(l => l.textContent); return lines.some(t => /info\\/refs|git-upload-pack|fetch done/.test(t)) })()`))))
    await evalJs(`(() => { const el = ${ROOT}?.querySelector('.bc-sync-log-head input[type=checkbox]'); if (el) el.click(); return 'ok' })()`)
    ok('debug toggle hides them again', await poll(async () => (await dbgShown()) === false))

    // ------------------------------------------------------------- push main ---
    await subTab(1)
    await setInput(ta, cfgText() + '\nbcE2ePush: ok\n')
    await click('.bc-section-head .btn-primary')
    await poll(() => Promise.resolve(/bcE2ePush:\s*ok/.test(cfgText())))
    await subTab(2)
    const pushTitle = await act(1, 0, /Push config package|推送配置包/)
    ok('push confirm modal shown', !!pushTitle)
    ok('push updates remote main', !!(await poll(async () => (await remoteContent('main')).includes('bcE2ePush'), 60000)))
    ok('lastPush recorded', await poll(() => evalJs(`(() => { const c = ${LASTCARD}; const spans = [...(c?.querySelectorAll('.bc-sync-source-last span') ?? [])]; const push = spans.find(s => /Last push|上次推送/.test(s.textContent)); return !!push && !/never|从未/.test(push.textContent) })()`)))
    const pushedContent = await remoteContent('main')
    ok('push excludes betterConfiger section', !!pushedContent && !pushedContent.includes('betterConfiger'))
    ok('sync log records the push', !!(await poll(() => logText().then(t => /pushed main -> origin/.test(t) ? true : null))))

    // --------------------------------------- push after remote divergence ---
    // "Remote wins" semantics: someone else pushed different content; our
    // push must land ON TOP of that history (fast-forward), not be rejected
    // into a force-push. The diverged commit must survive in the history and
    // the package content must end up ours (last writer wins, per file).
    if (GITHUB_MODE) {
        ok('github.com reachable (window 2)', await waitForGitHub())
    }
    const divergePkg = JSON.stringify({
        format: 'tabby-config-package', version: 1, kind: 'full',
        exportedAt: new Date().toISOString(), tabbyVersion: '1.0.237',
        modules: { marker: 'diverged-remotely' }, excluded: [],
    }, null, 2)
    await putContent('main', divergePkg, 'diverge')
    const push2Title = await act(1, 0, /Push config package|推送配置包/)
    ok('push-2 confirm modal shown', !!push2Title)
    ok('push after divergence lands (rebased on top)', !!(await poll(async () => (await remoteContent('main')).includes('bcE2ePush'), 60000)))
    if (!GITHUB_MODE) {
        const log = await gitOp(['log', '--oneline', 'origin/main']).then(r => r.stdout)
        ok('diverged commit preserved in history', /diverge/.test(log) && /BetterConfiger: update config package/.test(log), log.trim().split('\n').slice(0, 3).join(' | '))
    }
    ok('sync log records push-2', !!(await poll(() => logText().then(t => (/pushed main -> origin/.test(t) ? t.split(/pushed main -> origin/).length : 0) >= 3 ? true : null))))

    // --------------------------------------------- branch distribution (machine-a) ---
    await putContent('machine-a', pkgFor(RUN_VAL_A, `BC E2E ${RUN_VAL_A}`), `machine-a override ${RUN_VAL_A}`)
    // open the editor (retry — same click race as the action buttons)
    let editorOpen = false
    for (let i = 0; i < 4 && !editorOpen; i++) {
        await evalJs(`(() => { const bs = ${LASTCARD}?.querySelectorAll('.bc-sync-source-actions .btn'); if (bs && bs[2]) bs[2].click(); return 'ok' })()`) // Edit
        editorOpen = !!(await poll(() => evalBool(`${ROOT}?.querySelector('.bc-sync-editor')`), 4000, 300))
    }
    ok('edit opens source editor', editorOpen)
    await evalJs(`(() => { const els = ${ROOT}.querySelectorAll('.bc-sync-editor input[type=text]'); els[2].value = 'machine-a'; els[2].dispatchEvent(new Event('input', {bubbles:true})); return 'set' })()`)
    await click('.bc-sync-editor-actions .btn-primary')
    await poll(() => evalJs(`${LASTCARD}?.textContent.includes('machine-a')`))
    const branchTitle = await act(0, 0, /Pull config package|拉取配置包/)
    ok('branch pull confirm modal shown', !!branchTitle)
    ok('branch switch pull merges machine-a', !!(await poll(() => Promise.resolve(new RegExp(`showRecentProfiles:\\s*${RUN_VAL_A}\\b`).test(cfgText())), 60000)))

    // ------------------------------------------------------------- cleanup ---
    ok('sync log file persisted', await (async () => {
        try {
            const f = 'D:/Env/TabbyEnv/instances/bc/data/better-configer/sync.log'
            const text = fs.readFileSync(f, 'utf8')
            return /pushed/.test(text) && /DEBUG/.test(text)
        } catch {
            return false
        }
    })())

    // ------------------------------------------- network retry on a dead port ---
    // loopback bypass means this hits the (closed) port directly; the engine
    // must retry twice then surface the final error in the log
    await click('.bc-sync-head-actions .btn-primary') // Add source
    await sleep(200)
    await evalJs(`(() => { const els = ${ROOT}.querySelectorAll('.bc-sync-editor input[type=text]');
        els[0].value = 'E2E dead'; els[0].dispatchEvent(new Event('input', {bubbles:true}));
        els[1].value = 'http://127.0.0.1:9/repo.git'; els[1].dispatchEvent(new Event('input', {bubbles:true}));
        els[2].value = 'main'; els[2].dispatchEvent(new Event('input', {bubbles:true}));
        els[3].value = 'tabby-config.json'; els[3].dispatchEvent(new Event('input', {bubbles:true}));
        return 'set' })()`)
    await click('.bc-sync-editor-actions .btn-primary')
    await poll(() => evalBool(`${ROOT}?.querySelector('.bc-sync-source:last-child')`))
    // the pull errors BEFORE any confirm (fetch fails) — one click is enough;
    // the retries happen engine-side
    await evalJs(`(() => { const bs = ${LASTCARD}?.querySelectorAll('.bc-sync-source-actions .btn'); if (bs && bs[0]) bs[0].click(); return 'ok' })()`)
    ok('network retries logged', !!(await poll(() => logText().then(t => (t.match(/retrying/g) ?? []).length >= 2 ? true : null), 40000)))
    ok('final network error logged with hint', !!(await poll(() => logText().then(t => /E2E dead:.*(ECONNREFUSED|connect)/.test(t) ? true : null), 20000)))
    const delDead = await act(3, 0, /Delete this sync source|删除该同步源/)
    ok('dead-port source deleted', !!delDead)

    // Final cleanup, driven by the CONFIG end-state instead of one fragile
    // click: delete every remaining E2E source until config.yaml is clean.
    // (Racing Angular row re-renders with single clicks double-fires deletes
    // on already-gone ids; looping until the disk state is right is
    // deterministic regardless of UI timing.)
    let cleanupOk = false
    for (let guard = 0; guard < 8 && !cleanupOk; guard++) {
        cleanupOk = !/name:\s*E2E\b/.test(cfgText())
        if (cleanupOk) break
        const idx = await evalJs(`(() => { const cards = [...(${ROOT})?.querySelectorAll('.bc-sync-source') ?? []]; return cards.findIndex(c => /E2E/.test(c.textContent)) })()`)
        if (idx === null || idx < 0) {
            await sleep(1000) // DOM not caught up yet — wait for changed$
            continue
        }
        await evalJs(`(() => { const cards = [...(${ROOT})?.querySelectorAll('.bc-sync-source')]; const bs = cards[${idx}]?.querySelectorAll('.bc-sync-source-actions .btn'); if (bs && bs[3]) bs[3].click(); return 'ok' })()`)
        const m = await waitModal(6000)
        if (m) {
            await clickModalButton(0) // Delete
            await modalGone()
        }
        await sleep(800)
    }
    ok('E2E sources cleaned from UI + config', cleanupOk && !/name:\s*E2E\b/.test(cfgText()))
}

main().catch(e => { console.error(e); process.exit(1) })
