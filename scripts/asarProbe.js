/** One-off probe: inspect app.asar structure / extract files for plugin-loader research. */
const fs = require('fs')

const asarPath = process.argv[2]
const mode = process.argv[3] // 'root' | 'find' | 'extract'
const arg = process.argv[4]

const b = fs.readFileSync(asarPath)
const jsonStart = b.indexOf('{')
let depth = 0
let end = -1
let inStr = false
let esc = false
for (let i = jsonStart; i < b.length; i++) {
    const c = String.fromCharCode(b[i])
    if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
        depth--
        if (!depth) {
            end = i + 1
            break
        }
    }
}
const header = JSON.parse(b.slice(jsonStart, end).toString())
const base = Math.ceil(end / 4) * 4

function extract (innerPath) {
    const node = innerPath.split('/').filter(Boolean).reduce((n, seg) => n.files[seg], header)
    return b.slice(base + parseInt(node.offset), base + parseInt(node.offset) + node.size)
}

if (mode === 'root') {
    console.log(Object.keys(header.files).join('\n'))
} else if (mode === 'find') {
    // find files whose path matches a regex, print size
    const re = new RegExp(arg)
    const walk = (node, prefix) => {
        for (const [name, f] of Object.entries(node.files || {})) {
            const p = prefix + '/' + name
            if (f.files) {
                walk(f, p)
            } else if (re.test(p)) {
                console.log(f.size, p)
            }
        }
    }
    walk(header, '')
} else if (mode === 'extract') {
    process.stdout.write(extract(arg))
} else if (mode === 'grep') {
    // grep a symbol across all js files under a prefix dir
    const re = new RegExp(arg)
    const sym = process.argv[5]
    const walk = (node, prefix) => {
        for (const [name, f] of Object.entries(node.files || {})) {
            const p = prefix + '/' + name
            if (f.files) {
                walk(f, p)
            } else if (/\.js$/.test(p) && re.test(p)) {
                const content = extract(p)
                let i = content.indexOf(sym)
                let count = 0
                while (i !== -1 && count < 3) {
                    console.log(`--- ${p} @${i}:`)
                    console.log(content.slice(Math.max(0, i - 200), i + 400).toString())
                    i = content.indexOf(sym, i + sym.length)
                    count++
                }
            }
        }
    }
    walk(header, '')
}
