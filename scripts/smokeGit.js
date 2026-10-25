/** Engine-level smoke for the isomorphic-git flow used by GitSyncService,
 *  against a LOCAL bare repo (no network): fetch → readBlob → write → commit
 *  → push → non-ff rejection → force push. If local-path remotes turn out
 *  unsupported, the same flow runs in the CDP E2E against GitHub instead.
 *
 *   node scripts/smokeGit.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const git = require('isomorphic-git')
const http = require('isomorphic-git/http/node')

function fail (msg) {
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
}
const ok = (name, cond) => {
    console.log(`[${cond ? 'ok' : 'FAIL'}] ${name}`)
    if (!cond) process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-git-'))
const origin = path.join(tmp, 'origin.git')
const work = path.join(tmp, 'cache')
const PKG = 'tabby-config.json'

async function main () {
    // --- origin: bare-ish repo seeded with a package on main ---
    fs.mkdirSync(origin)
    await git.init({ fs, dir: origin, defaultBranch: 'main' })
    fs.writeFileSync(path.join(origin, PKG), JSON.stringify({
        format: 'tabby-config-package', version: 1, kind: 'full',
        exportedAt: new Date().toISOString(), tabbyVersion: '1.0.0',
        modules: { terminal: { showBuiltinProfiles: true } }, excluded: [],
    }))
    await git.add({ fs, dir: origin, filepath: PKG })
    const o1 = await git.commit({
        fs, dir: origin, message: 'seed',
        author: { name: 't', email: 't@t' },
    })
    // a distribution branch off main
    await git.branch({ fs, dir: origin, ref: 'machine-a' })
    console.log(`origin seeded: main=${o1.slice(0, 8)}, branches=main,machine-a`)

    // --- cache repo: init + remote over local path ---
    fs.mkdirSync(work, { recursive: true })
    await git.init({ fs, dir: work, defaultBranch: 'main' })
    fs.writeFileSync(path.join(work, '.better-configer-branch'), 'main')
    await git.addRemote({ fs, dir: work, remote: 'origin', url: origin })

    // fetch main + read the package at HEAD without a checkout
    await git.fetch({ fs, http, dir: work, remote: 'origin', ref: 'main', singleBranch: true })
    const head = await git.resolveRef({ fs, dir: work, ref: 'refs/remotes/origin/main' })
    const blob = await git.readBlob({ fs, dir: work, oid: head, filepath: PKG })
    const pkg = JSON.parse(Buffer.from(blob.blob).toString('utf8'))
    ok('fetch + readBlob over local path', pkg.modules.terminal.showBuiltinProfiles === true)

    // unborn-HEAD path: fresh dir for a NEW branch that exists only on origin
    const work2 = path.join(tmp, 'cache2')
    fs.mkdirSync(work2, { recursive: true })
    await git.init({ fs, dir: work2, defaultBranch: 'machine-a' })
    fs.writeFileSync(path.join(work2, '.better-configer-branch'), 'machine-a')
    await git.addRemote({ fs, dir: work2, remote: 'origin', url: origin })
    await git.fetch({ fs, http, dir: work2, remote: 'origin', ref: 'machine-a', singleBranch: true })
    const headA = await git.resolveRef({ fs, dir: work2, ref: 'refs/remotes/origin/machine-a' })
    // syncWorktreeToBranch equivalent: adopt the remote branch locally
    await git.branch({ fs, dir: work2, ref: 'machine-a', object: headA })
    await git.checkout({ fs, dir: work2, ref: 'machine-a', force: true })
    fs.writeFileSync(path.join(work2, PKG), JSON.stringify({ ...pkg, modules: { terminal: { showBuiltinProfiles: false } } }))
    await git.add({ fs, dir: work2, filepath: PKG })
    const c1 = await git.commit({
        fs, dir: work2, message: 'machine-a update',
        author: { name: 'BetterConfiger', email: 'bc@tabby.local' },
    })
    await git.push({ fs, http, dir: work2, remote: 'origin', ref: 'machine-a' })
    ok('write + commit + push (branch from origin)', !!c1)

    // non-ff rejection: push a different commit from `work` (still at seed)
    fs.writeFileSync(path.join(work, PKG), JSON.stringify({ ...pkg, marker: 'from-work' }))
    await git.add({ fs, dir: work, filepath: PKG })
    await git.commit({
        fs, dir: work, message: 'divergent',
        author: { name: 'BetterConfiger', email: 'bc@tabby.local' },
    })
    let rejected = false
    try {
        await git.push({ fs, http, dir: work, remote: 'origin', ref: 'main' })
    } catch (e) {
        // main on origin is AHEAD (branch point after seed? no — work pushes
        // main while machine-a moved; main itself didn't move. To force a
        // real non-ff we push work's main as machine-a.)
        rejected = true
    }
    // real non-ff: work's divergent history pushed to machine-a
    let rejectedReal = false
    try {
        await git.push({ fs, http, dir: work, remote: 'origin', ref: 'main:refs/heads/machine-a' })
    } catch {
        rejectedReal = true
    }
    ok('non-fast-forward push rejected', rejectedReal)
    await git.push({ fs, http, dir: work, remote: 'origin', ref: 'main:refs/heads/machine-a', force: true })
    const finalA = await git.resolveRef({ fs, dir: origin, ref: 'refs/heads/machine-a' })
    const finalWork = await git.resolveRef({ fs, dir: work, ref: 'refs/heads/main' })
    ok('force push overwrites', finalA === finalWork)

    // fetch of a missing branch must not crash the caller's flow (we treat
    // it as "branch does not exist yet")
    let missing = null
    try {
        await git.fetch({ fs, http, dir: work, remote: 'origin', ref: 'no-such-branch', singleBranch: true })
    } catch (e) {
        missing = String(e?.message ?? e)
    }
    console.log('      missing-branch fetch →', missing ? missing.slice(0, 90) : '(no error)')
    // pushing to a brand-new remote branch from a fresh unborn cache
    const work3 = path.join(tmp, 'cache3')
    fs.mkdirSync(work3, { recursive: true })
    await git.init({ fs, dir: work3, defaultBranch: 'brand-new' })
    await git.addRemote({ fs, dir: work3, remote: 'origin', url: origin })
    fs.writeFileSync(path.join(work3, PKG), JSON.stringify({ ...pkg, marker: 'brand-new' }))
    await git.add({ fs, dir: work3, filepath: PKG })
    await git.commit({ fs, dir: work3, message: 'first', author: { name: 't', email: 't@t' } })
    await git.push({ fs, http, dir: work3, remote: 'origin', ref: 'brand-new' })
    const bn = await git.resolveRef({ fs, dir: origin, ref: 'refs/heads/brand-new' })
    ok('push to brand-new remote branch (unborn cache)', !!bn)

    fs.rmSync(tmp, { recursive: true, force: true })
    console.log('\nengine smoke passed')
}

main().catch(e => fail(e?.stack ?? e))
