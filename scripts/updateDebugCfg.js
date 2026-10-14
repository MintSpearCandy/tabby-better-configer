/** Deploy the freshly built plugin into the central debug environment
 *  (D:\Env\TabbyEnv\instances). The instances themselves are created/managed
 *  by that environment's tools\tabby.ps1 (new/start/stop/status) — this script
 *  only pushes dist\ + package.json.
 *
 *  `--app` additionally deploys to the user's REAL Tabby at D:\App\Tabby —
 *  opt-in only: never fold the real environment into the default run.
 *  Restart the instance afterwards to load the new version (plugins load at
 *  startup only). Start the dedicated sandbox with:
 *    powershell D:\Env\TabbyEnv\tools\tabby.ps1 start bc      (CDP port 9233)
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = root
const targets = [
    'D:\\Env\\TabbyEnv\\instances\\bc\\data\\plugins\\node_modules\\tabby-better-configer',
    'D:\\Env\\TabbyEnv\\instances\\main\\data\\plugins\\node_modules\\tabby-better-configer',
]

if (process.argv.includes('--app')) {
    targets.push('D:\\App\\Tabby\\data\\plugins\\node_modules\\tabby-better-configer')
}

for (const dst of targets) {
    if (!fs.existsSync(path.dirname(dst))) {
        console.log('skip (missing dir)', dst)
        continue
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true })
    fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
    console.log('updated', dst)
}
