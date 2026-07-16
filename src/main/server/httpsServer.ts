import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import log from 'electron-log'

const serverLog = log.scope('server')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
}

/**
 * Static file handler for the phone page, hardened against path traversal:
 * resolves within `rootDir` only.
 */
export function makeStaticHandler(rootDir: string) {
  const root = path.resolve(rootDir)
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'https://local')
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const candidate = path.resolve(root, '.' + path.posix.normalize(rel))
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(candidate, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(candidate)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      res.end(buf)
    })
  }
}

export interface RunningServer {
  server: https.Server
  port: number
}

/**
 * Bind the HTTPS server on 0.0.0.0:preferredPort, falling back to an
 * ephemeral port when taken. Token gates signaling, not static pages.
 */
export function startHttpsServer(opts: {
  cert: string
  key: string
  phoneDistDir: string
  preferredPort: number
}): Promise<RunningServer> {
  const handler = makeStaticHandler(opts.phoneDistDir)
  const server = https.createServer({ cert: opts.cert, key: opts.key }, handler)

  return new Promise((resolve, reject) => {
    const tryListen = (port: number, isRetry: boolean): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (!isRetry && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          serverLog.warn(`port ${port} unavailable (${err.code}), falling back to ephemeral port`)
          tryListen(0, true)
        } else {
          reject(err)
        }
      })
      server.listen(port, '0.0.0.0', () => {
        server.removeAllListeners('error')
        const bound = (server.address() as AddressInfo).port
        serverLog.info(`listening on https://0.0.0.0:${bound}`)
        resolve({ server, port: bound })
      })
    }
    tryListen(opts.preferredPort, false)
  })
}
