/** Deploy the freshly built plugin into the dedicated sandbox Tabby instance
 *  (test-env\tabby-bc). Creates that instance on first run by copying the
 *  portable install at D:\App\Tabby (without its data\ folder, so the sandbox
 *  starts from a clean userData).
 *
 *  `--app` additionally deploys to the user's REAL Tabby at D:\App\Tabby —
 *  opt-in only: never fold the real environment into the default run.
 *  Restart the instance afterwards to load the new version (plugins load at
 *  startup only). Start the sandbox with:
 *    Start-Process '<repo>\test-env\tabby-bc\Tabby.exe' -ArgumentList '--remote-debugging-port=9233'
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const src = root
const PORTABLE_SOURCE = 'D:\\App\\Tabby'
const sandboxDir = path.join(root, 'test-env', 'tabby-bc')
const targets = [
    path.join(sandboxDir, 'data', 'plugins', 'node_modules', 'tabby-better-configer'),
]

function ensureSandbox () {
    if (fs.existsSync(path.join(sandboxDir, 'Tabby.exe'))) {
        return
    }
    console.log(`Creating sandbox instance at ${sandboxDir} (one-time copy of ${PORTABLE_SOURCE})...`)
    // robocopy mirrors the portable install but excludes data\ (sandbox gets
    // its own clean userData). robocopy exit codes 0-7 are success.
    const r = spawnSync('robocopy', [
        PORTABLE_SOURCE, sandboxDir, '/E', '/XD', 'data', '/NFL', '/NDL', '/NJH', '/NJS',
    ], { stdio: 'inherit' })
    if (r.status !== null && r.status > 7) {
        console.error(`[x] robocopy failed with exit code ${r.status}`)
        process.exit(1)
    }
    fs.mkdirSync(path.join(sandboxDir, 'data'), { recursive: true })
    console.log('[ok] sandbox instance created')
}

ensureSandbox()

if (process.argv.includes('--app')) {
    targets.push('D:\\App\\Tabby\\data\\plugins\\node_modules\\tabby-better-configer')
}

for (const dst of targets) {
    if (!fs.existsSync(path.dirname(dst)) && !dst.startsWith(sandboxDir)) {
        // non-sandbox target (e.g. --app on a machine without that Tabby)
        console.log('skip (missing dir)', dst)
        continue
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true })
    fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
    console.log('updated', dst)
}
