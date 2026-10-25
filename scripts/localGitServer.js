/** Minimal git smart-http server on 127.0.0.1 for E2E (backs git http-backend).
 *  Serves every repo under <root> as /<name>.git — anonymous fetch AND push
 *  (http.receivepack=true). Usage:
 *    node scripts/localGitServer.js [port]        (standalone)
 *    require('./localGitServer').start(port)      (in-process, returns handle)
 */
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const GIT_BACKEND = 'git'

function handle (root, req, res) {
    const u = new URL(req.url, 'http://localhost')
    const m = u.pathname.match(/^\/([^/]+\.git)(\/.*)$/)
    if (!m) {
        res.writeHead(404).end('no repo in path')
        return
    }
    const [, repo, pathInfo] = m
    if (!fs.existsSync(path.join(root, repo, 'HEAD'))) {
        res.writeHead(404).end('repo not found')
        return
    }
    const env = {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${repo}${pathInfo}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: u.searchParams.toString(),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
    }
    if (req.headers['content-length']) {
        env.CONTENT_LENGTH = req.headers['content-length']
    }
    const backend = spawn(GIT_BACKEND, ['http-backend'], { env })
    if (process.env.BC_GITSRV_DEBUG) {
        console.log(`[srv] ${req.method} ${u.pathname} CL=${env.CONTENT_LENGTH ?? '-'} pid=${backend.pid}`)
    }
    req.pipe(backend.stdin)
    // CGI response: headers up to blank line, then body. Buffer the header
    // part (small), stream the rest.
    let headerBuf = Buffer.alloc(0)
    let headersDone = false
    let status = 200
    const outHeaders = {}
    backend.on('exit', (code, signal) => {
        if (process.env.BC_GITSRV_DEBUG) {
            console.log(`[srv] backend exit code=${code} signal=${signal ?? '-'} headersDone=${headersDone}`)
        }
    })
    backend.stdout.on('data', chunk => {
        if (headersDone) {
            res.write(chunk)
            return
        }
        headerBuf = Buffer.concat([headerBuf, chunk])
        const split = headerBuf.indexOf('\r\n\r\n')
        if (split === -1) {
            return
        }
        const raw = headerBuf.slice(0, split).toString('utf8')
        for (const line of raw.split('\r\n')) {
            const i = line.indexOf(':')
            if (i === -1) continue
            const k = line.slice(0, i).trim()
            const v = line.slice(i + 1).trim()
            if (k.toLowerCase() === 'status') {
                status = parseInt(v, 10) || 200
            } else {
                outHeaders[k] = v
            }
        }
        headersDone = true
        res.writeHead(status, outHeaders)
        const body = headerBuf.slice(split + 4)
        if (body.length) {
            res.write(body)
        }
    })
    backend.stdout.on('end', () => {
        if (!headersDone) {
            res.writeHead(500).end('backend produced no headers')
        } else {
            res.end()
        }
    })
    backend.on('error', e => res.writeHead(500).end(String(e)))
    backend.stderr.on('data', d => process.stderr.write(`[http-backend] ${d}`))
}

function start (port = 9239, root = path.join(__dirname, '..', 'test-env', 'gitserver', 'root')) {
    fs.mkdirSync(root, { recursive: true })
    const server = http.createServer((req, res) => {
        try {
            handle(root, req, res)
        } catch (e) {
            res.writeHead(500).end(String(e))
        }
    })
    return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
            console.log(`[localGitServer] http://127.0.0.1:${port} serving ${root}`)
            resolve({ server, port, root, close: () => new Promise(r => server.close(r)) })
        })
    })
}

if (require.main === module) {
    start(Number(process.argv[2] || 9239), process.argv[3])
}

module.exports = { start }
