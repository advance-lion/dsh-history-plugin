/**
 * 宿主 HTTP 接口：客户端半边（历史插件页 / 历史安装页签）通过它读写宿主状态。
 *
 * ## 安全：为什么每一层都不能省
 *
 * 这些路由挂在裸 `webServer` 上，**不过宿主自己的请求闸就等于没有认证**。
 * dshmarket 的源码把这件事写得很清楚：它的路由是 webServer 上的精确注册，
 * 不经过闸门，所以在开了登录的部署上，「一个没有会话的客户端照样能读状态、
 * 装插件、卸插件」——对任何能碰到这个端口的人就是远程执行代码。
 *
 * 这里的手法是照抄它、而不是自己发明一套登录：
 *
 *  1. **宿主闸门优先**：`connection.requestRejection(request)` 是宿主自己 API 用的
 *     那套 Host/Origin 围栏加浏览器登录，返回 403 / 401 / undefined。每次请求现取，
 *     这样插件可以先挂载、服务后到。闸门抛异常时按 403 处理——闸门坏了不等于放行。
 *  2. **改动类请求再校同源**：`Origin` 存在就必须与 `Host` 同源；`Origin: null`
 *     （沙箱 iframe、data: 文档）与空 `Origin` 一律拒绝。没有 `Origin` 的放行，
 *     因为浏览器发 POST 必带它（含同源），没有就说明调用方不是页面，而桌面端代理
 *     会把 `origin`/`host` 剥掉——这一点是 dshmarket 用真机踩出来的。
 *  3. **Host 必须是回环或已声明**：防 DNS rebinding——攻击页面的 `Origin` 与 `Host`
 *     可以同时是 `evil.com`，只有 `Host` 是它伪造不了的。
 *  4. 方法不对给 405（带 `allow`），请求体超限/解析失败给 400。
 *
 * 响应里**永远不放 token**：所有 handler 只返回同步状态与历史，凭据只进不出。
 */

import { Buffer } from 'node:buffer'

/** 接口前缀。 */
export const API_PREFIX = '/dsh-history-plugin/api/v1'
/** 请求体上限：批量重装要带一串包名，4 KiB 偏紧，给 16 KiB。 */
export const BODY_LIMIT = 16 * 1024

/**
 * 写出 JSON 响应。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {number} status 状态码。
 * @param {unknown} body 响应体。
 * @returns {void}
 */
/**
 * 发送一个 HTML 页面（本机授权回调页要用它：token 只在页面片段里，必须由页面自己的
 * JS 取出来再 POST 给宿主，所以这里必须能返回真正的 HTML 而不是 JSON）。
 * @param {any} response 响应对象。
 * @param {number} status 状态码。
 * @param {string} html 页面内容。
 */
export function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(html)
}

/**
 * 发送 JSON 响应。
 * @param {any} response 响应对象。
 * @param {number} status 状态码。
 * @param {any} body 响应体。
 */
export function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * 读并解析 JSON 请求体，超过上限即拒绝。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @param {number} [maxBytes] 上限。
 * @returns {Promise<unknown>} 解析结果。
 */
export async function readJsonBody(request, maxBytes = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error(`请求体超过 ${maxBytes} 字节`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * `Host` 是否指向回环。
 * @param {string|undefined} host Host 头。
 * @returns {boolean} 是否回环。
 */
export function loopbackAuthority(host) {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * 把 `host[:port]` 解析成规范形式；不是合法 authority 时返回 null。
 * @param {string} value 待解析的值。
 * @returns {URL|null} 解析结果。
 */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

/**
 * authority 是否在宿主声明的可信列表里。
 * @param {string} host Host 头。
 * @param {readonly string[]} trustedHosts 宿主声明的 authority。
 * @returns {boolean} 是否可信。
 */
export function trustedAuthority(host, trustedHosts) {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * 改动类请求的同源校验。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @param {readonly string[]} trustedHosts 宿主声明的 authority。
 * @returns {boolean} 是否放行。
 */
export function sameOrigin(request, trustedHosts = []) {
  const host = request.headers.host
  // Host 是攻击页面伪造不了的那个头，防的是 DNS rebinding。
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // 没有 Origin = 调用方不是页面（桌面端代理会剥掉它）；浏览器发 POST 必带。
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    // Origin: null 或空串都是「存在但不可解析」，拒绝。
    return false
  }
}

/**
 * 建立接口。
 *
 * @param {{
 *   getConnection: () => any,
 *   handlers: Record<string, (body: any, request: import('node:http').IncomingMessage) => Promise<unknown>>,
 *   log?: (level: string, event: string, detail: string) => void,
 *   bodyLimit?: number,
 * }} options 依赖与处理器。
 * @returns {{ register: (webServer: any) => () => void, handle: (name: string, request: any, response: any) => Promise<void>, routes: object[] }} 接口。
 */
export function createHttpApi(options) {
  const log = options.log ?? (() => {})
  const bodyLimit = options.bodyLimit ?? BODY_LIMIT
  const handlers = options.handlers

  /** 取宿主声明的可信 authority；取不到就是空列表。 */
  function trustedHosts() {
    const connection = options.getConnection()
    return Array.isArray(connection?.trustedHosts)
      ? connection.trustedHosts.filter(entry => typeof entry === 'string')
      : []
  }

  /**
   * 问宿主的闸门。返回 undefined 表示放行。
   * @param {import('node:http').IncomingMessage} request 请求。
   * @returns {number|undefined} 拒绝状态码。
   */
  function gate(request) {
    const connection = options.getConnection()
    const reject = connection?.requestRejection
    if (typeof reject !== 'function') return undefined
    try {
      const status = reject.call(connection, request)
      return typeof status === 'number' ? status : undefined
    } catch (error) {
      // 闸门抛异常不等于放行，否则宿主的一个 bug 就变成了这里的安全漏洞。
      log('warn', 'http-gate-error', error instanceof Error ? error.message : String(error))
      return 403
    }
  }

  /** 路由表。`mutating` 为真时额外做同源校验。 */
  const routes = [
    { name: 'status', method: 'GET', path: `${API_PREFIX}/status`, mutating: false },
    { name: 'history', method: 'GET', path: `${API_PREFIX}/history`, mutating: false },
    { name: 'devices', method: 'GET', path: `${API_PREFIX}/devices`, mutating: false },
    { name: 'sync', method: 'POST', path: `${API_PREFIX}/sync`, mutating: true },
    { name: 'reinstall', method: 'POST', path: `${API_PREFIX}/reinstall`, mutating: true },
    { name: 'credential', method: 'POST', path: `${API_PREFIX}/credential`, mutating: true },
    { name: 'credential', method: 'DELETE', path: `${API_PREFIX}/credential`, mutating: true },
    { name: 'oauth-authorize-url', method: 'POST', path: `${API_PREFIX}/oauth/authorize-url`, mutating: true },
    { name: 'oauth-callback', method: 'POST', path: `${API_PREFIX}/oauth/callback`, mutating: true },
    // 一键授权：开会话（POST）与查状态（GET）共用一个路径；回调页是 GET（浏览器导航）。
    { name: 'oauth-session', method: 'POST', path: `${API_PREFIX}/oauth/session`, mutating: true },
    { name: 'oauth-session-status', method: 'GET', path: `${API_PREFIX}/oauth/session` },
    { name: 'oauth-redirect', method: 'GET', path: `${API_PREFIX}/oauth/redirect` },
    { name: 'storage-test', method: 'POST', path: `${API_PREFIX}/storage-test`, mutating: true },
    { name: 'device', method: 'POST', path: `${API_PREFIX}/device`, mutating: true },
  ]

  /**
   * 处理一次请求：先过闸门，再按方法分派。
   *
   * 同一个路径上可能挂多个方法（`/credential` 的 POST 与 DELETE），而
   * `webServer.register` 是**按路径**注册的——同路径注册两次会互相覆盖，
   * 后注册的那个把先注册的挤掉。所以一个路径只注册一条，方法在内部区分。
   *
   * @param {object[]} list 该路径上的路由（方法不同）。
   * @param {import('node:http').IncomingMessage} request 请求。
   * @param {import('node:http').ServerResponse} response 响应。
   * @returns {Promise<void>} 完成。
   */
  async function dispatch(list, request, response) {
    // 1. 宿主闸门：登录 + Host/Origin 围栏。认证先于一切。
    const rejected = gate(request)
    if (rejected !== undefined) {
      sendJson(response, rejected, { error: rejected === 401 ? '需要先登录 DSH。' : '请求被宿主的来源校验拒绝。' })
      return
    }
    // 2. 方法。
    const route = list.find(item => item.method === request.method)
    if (route === undefined) {
      response.writeHead(405, { allow: [...new Set(list.map(item => item.method))].join(', ') })
      response.end()
      return
    }
    // 3. 改动类请求的同源校验。
    if (route.mutating && !sameOrigin(request, trustedHosts())) {
      sendJson(response, 403, { error: '跨站请求已被拒绝。' })
      return
    }
    // 4. 请求体。
    let body = {}
    if (route.method !== 'GET' && route.method !== 'DELETE') {
      try {
        body = await readJsonBody(request, bodyLimit)
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    // 5. 执行。
    const handler = handlers[route.name]
    if (typeof handler !== 'function') {
      sendJson(response, 501, { error: `接口未实现：${route.name}` })
      return
    }
    try {
      const result = await handler(body, request)
      // 处理器可以返回 `__html` 来直接给浏览器一个页面（授权回调页），其余一律 JSON。
      if (result !== null && typeof result === 'object' && typeof result.__html === 'string') {
        sendHtml(response, 200, result.__html)
        return
      }
      sendJson(response, 200, { ok: true, ...(result !== null && typeof result === 'object' ? result : { result }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', 'http-handler-failed', `${route.name}: ${message}`)
      // 只把消息回给同源调用方；错误消息本身已由传输层脱敏，不含 token。
      sendJson(response, 500, { ok: false, error: message })
    }
  }

  /** 路径 → 该路径上的路由列表。 */
  const byPath = new Map()
  for (const route of routes) {
    const list = byPath.get(route.path) ?? []
    list.push(route)
    byPath.set(route.path, list)
  }

  return {
    routes,
    /**
     * 实际注册到 webServer 的路径列表。同一个路径上多个方法只算一条——
     * 这是 webServer.register 真正看到的数量，诊断时别和 routes.length 混了。
     */
    registeredPaths: [...byPath.keys()],
    /**
     * 用一个 name 直接驱动（测试用）。
     * @param {string} name 路由名。
     * @param {any} request 请求。
     * @param {any} response 响应。
     * @returns {Promise<void>} 完成。
     */
    async handle(name, request, response) {
      const candidates = routes.filter(item => item.name === name)
      if (candidates.length === 0) throw new Error(`未知接口：${name}`)
      const path = candidates[0].path
      return dispatch(byPath.get(path) ?? candidates, request, response)
    },
    /**
     * 注册到 webServer：每个路径一条。
     * @param {any} webServer webServer 服务。
     * @returns {() => void} 释放函数。
     */
    register(webServer) {
      const disposers = [...byPath.entries()].map(([path, list]) => webServer.register({
        kind: 'exact',
        path,
        handler: (request, response) => {
          void dispatch(list, request, response).catch(error => {
            log('error', 'http-route-crashed', error instanceof Error ? error.message : String(error))
            try {
              sendJson(response, 500, { error: '内部错误' })
            } catch {
              /* 响应可能已经写出去了，忽略。 */
            }
          })
        },
      }))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 释放失败不该影响其余路由。 */
          }
        }
      }
    },
  }
}
