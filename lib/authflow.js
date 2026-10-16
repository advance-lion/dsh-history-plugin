/**
 * 授权会话：百度网盘「公开演示应用 + 隐式流程」的一键连接。
 *
 * 事实依据（都已实测）：
 *  - 百度网盘开放平台目前**仅限企业开发者注册应用**，个人只有「限时体验」入口；
 *    该入口用的是一个**公开的演示 client_id**（见 DEMO_APP_KEY），所以普通用户无需
 *    注册任何应用即可授权。
 *  - 演示应用在开放平台只登记了 `redirect_uri=oob`，这是它唯一能用的回调形态；把
 *    本机或其他地址交给它，百度授权页会直接报 `redirect_uri_mismatch / Invalid
 *    redirect uri`。授权完成后百度停在
 *    `https://openapi.baidu.com/oauth/2.0/login_success#access_token=…`，token 在
 *    **URL 片段**里，片段只有浏览器端可见、不会自动回跳到本机。DSH Desktop 中，Client
 *    在插件自有的 guest webview 里打开授权页并读取该页面的成功地址；非 Desktop 或桥不可用
 *    时才回退到连接会话有效期内读取剪贴板。两条路径都把原文交给 Host，由 Host 校验 state
 *    和提取 token，用户不需要再手动粘贴到输入框。
 *  - 本机回调页（`/oauth/redirect`）只在用户**自己的应用**登记了这个回调地址时才可用；
 *    它服务于下面的授权码流程，不能配演示应用使用。
 *  - 设备码流程当前不实现：`GET /oauth/2.0/device/code` 实测返回 200，并能拿到
 *    device_code；但用演示应用换 token 时缺少非空 client_secret 会被百度拒绝，而
 *    演示应用没有可安全使用的 SecretKey，所以这条零注册路径仍不可用。
 *
 * 安全约定：token 只在内存里从「页面片段」传到「宿主凭据存储」，不进 URL 日志、
 * 不进浏览器历史（页面会立刻 replaceState）、不进插件日志、不回显给 Client。
 */

/** 百度官方 MCP 文档给个人用户的公开演示应用 ID（非机密，等价于 client_id）。 */
export const DEMO_APP_KEY = 'QHOuRXiepJBMjtk0esLhrPoNlQyYd0mF'

/** 公开演示应用在百度开放平台登记的唯一回调形态：带外（oob）。 */
export const DEMO_REDIRECT_URI = 'oob'

/** 授权页。 */
export const AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize'

/** 网盘能力所需的 scope。 */
export const DEFAULT_SCOPE = 'basic,netdisk'

/** 一次性授权会话的有效期：超过就作废，避免留下「看起来还连着」的假状态。 */
export const SESSION_TTL_MS = 10 * 60 * 1000

/** token 形态校验：够长、只含 URL 安全字符。 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/

/**
 * 计算实际要用的回调地址。
 *
 * 公开演示应用在开放平台只登记了 `oob`，所以只要 client_id 落到演示应用，就必须
 * 覆盖调用方传来的任何回调；自己的应用则按开放平台登记的值原样使用。
 *
 * @param {{ appKey?: string, redirectUri?: string }} options 参数。
 * @returns {string} 实际使用的 redirect_uri。
 */
export function resolveRedirectUri(options) {
  const appKey = typeof options.appKey === 'string' && options.appKey !== '' ? options.appKey : DEMO_APP_KEY
  return appKey === DEMO_APP_KEY ? DEMO_REDIRECT_URI : options.redirectUri
}

/**
 * 拼授权页地址（隐式流程，token 随片段返回）。
 * @param {{ appKey?: string, redirectUri: string, scope?: string, state?: string }} options 参数。
 * @returns {string} 完整授权页地址。
 */
export function buildImplicitAuthorizeUrl(options) {
  const appKey = typeof options.appKey === 'string' && options.appKey !== '' ? options.appKey : DEMO_APP_KEY
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: appKey,
    redirect_uri: resolveRedirectUri(options),
    scope: options.scope ?? DEFAULT_SCOPE,
  })
  if (typeof options.state === 'string' && options.state !== '') params.set('state', options.state)
  return `${AUTHORIZE_URL}?${params.toString()}`
}

/**
 * 拼授权页地址（授权码流程，需要自己的应用与 SecretKey，用于企业路径）。
 * @param {{ appKey?: string, redirectUri: string, scope?: string, state?: string }} options 参数。
 * @returns {string} 完整授权页地址。
 */
export function buildCodeAuthorizeUrl(options) {
  const appKey = typeof options.appKey === 'string' && options.appKey !== '' ? options.appKey : DEMO_APP_KEY
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: appKey,
    redirect_uri: resolveRedirectUri(options),
    scope: options.scope ?? DEFAULT_SCOPE,
  })
  if (typeof options.state === 'string' && options.state !== '') params.set('state', options.state)
  return `${AUTHORIZE_URL}?${params.toString()}`
}

/** 把 `a=1&b=2` 解析成对象（容错，不抛）。 */
function parsePairs(text) {
  const out = {}
  for (const chunk of String(text).split('&')) {
    if (chunk === '') continue
    const index = chunk.indexOf('=')
    const key = index < 0 ? chunk : chunk.slice(0, index)
    const value = index < 0 ? '' : chunk.slice(index + 1)
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      out[key] = value
    }
  }
  return out
}

/** 取出片段或查询串（片段优先：隐式流程的 token 在片段里）。 */
function paramsOf(input) {
  const text = String(input).trim()
  const hash = text.indexOf('#')
  if (hash >= 0) return parsePairs(text.slice(hash + 1))
  const query = text.indexOf('?')
  if (query >= 0) return parsePairs(text.slice(query + 1))
  if (text.includes('=')) return parsePairs(text)
  return null
}

/**
 * 从用户手上拿到的东西里提取 access token。
 * 支持：整条跳转地址（片段或查询串）、`access_token=…` 片段、JSON、以及 token 本身。
 * @param {unknown} input 原始输入。
 * @returns {{ ok: true, token: string, expiresIn: number|null } | { ok: false, reason: string }} 结果。
 */
export function extractToken(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.length > 4096) return { ok: false, reason: 'too-long' }
  // 直接就是 token
  if (TOKEN_PATTERN.test(text) && !text.includes('=') && !text.includes('/')) {
    return { ok: true, token: text, expiresIn: null }
  }
  let pairs = paramsOf(text)
  if (pairs === null && text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      pairs = { access_token: parsed?.access_token, expires_in: parsed?.expires_in }
    } catch {
      pairs = null
    }
  }
  const token = typeof pairs?.access_token === 'string' ? pairs.access_token.trim() : ''
  if (token === '') return { ok: false, reason: 'no-token' }
  if (!TOKEN_PATTERN.test(token)) return { ok: false, reason: 'bad-token' }
  const seconds = Number(pairs?.expires_in)
  return { ok: true, token, expiresIn: Number.isFinite(seconds) && seconds > 0 ? seconds : null }
}

/**
 * 把隐式流程解析出的 token 收成凭据层可直接保存的 grant。
 *
 * `expiresAt` 必须是绝对毫秒时间戳，和授权码 / 刷新流程（`lib/oauth.js`）保持同一
 * 形状。写成 ISO 字符串会在凭据归一化时被丢掉，导致到期判断失灵。
 *
 * @param {{ ok: true, token: string, expiresIn: number|null } | { ok: false, reason: string }} parsed
 *   提取结果。
 * @param {{ now?: () => number, scope?: string }} [options] 参数。
 * @returns {{ accessToken: string, refreshToken: null, expiresAt: number|null, scope: string }} grant。
 */
export function implicitGrant(parsed, options = {}) {
  if (parsed?.ok !== true) {
    throw new Error(`没有可用的 access token（${parsed?.reason ?? 'unknown'}）`)
  }
  const now = typeof options.now === 'function' ? options.now() : Date.now()
  return {
    accessToken: parsed.token,
    refreshToken: null,
    expiresAt: parsed.expiresIn === null ? null : now + parsed.expiresIn * 1000,
    scope: options.scope ?? DEFAULT_SCOPE,
  }
}

/**
 * 一次性授权会话（同一时刻只允许一个：并发授权只会互相打断）。
 *
 * 方案要求「授权失败、取消或超时都不得留下已连接的假状态」——所以会话只有被
 * **完成并消费**一次才算数，过期后一律按不存在处理。
 *
 * @param {{ ttlMs?: number, now?: () => number, randomState?: () => string }} [options] 参数。
 * @returns {object} 会话管理器。
 */
export function createAuthSessions(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : SESSION_TTL_MS
  const now = options.now ?? (() => Date.now())
  const randomState = options.randomState ?? (() => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10))
  let current = null

  const expired = session => session === null || now() - session.startedAt > ttlMs

  return {
    /**
     * 开一次授权会话。
     * @param {{ appKey?: string, redirectUri: string, scope?: string, mode?: 'implicit'|'code' }} params 参数。
     * @returns {{ state: string, authorizeUrl: string, redirectUri: string, expiresAt: string, mode: string }} 会话。
     */
    start(params) {
      const mode = params.mode === 'code' ? 'code' : 'implicit'
      const state = randomState()
      const startedAt = now()
      // 会话记录的回调必须与授权页实际发出的一致：授权码流程换 token 时百度会比对它。
      const redirectUri = resolveRedirectUri(params)
      const authorizeUrl = mode === 'code'
        ? buildCodeAuthorizeUrl({ ...params, redirectUri, state })
        : buildImplicitAuthorizeUrl({ ...params, redirectUri, state })
      current = { state, mode, redirectUri, appKey: params.appKey ?? DEMO_APP_KEY, startedAt, authorizeUrl }
      return {
        state,
        mode,
        authorizeUrl,
        redirectUri: current.redirectUri,
        expiresAt: new Date(startedAt + ttlMs).toISOString(),
      }
    },
    /**
     * 取当前会话（过期即视为没有）。
     * @returns {object|null} 会话快照。
     */
    peek() {
      if (expired(current)) {
        current = null
        return null
      }
      return { state: current.state, mode: current.mode, redirectUri: current.redirectUri, expiresAt: new Date(current.startedAt + ttlMs).toISOString() }
    },
    /**
     * 带 state 校验地取会话：回调必须带对 state，否则一律拒绝。
     * @param {unknown} state 回调带来的 state。
     * @returns {{ ok: true, session: object } | { ok: false, reason: string }} 结果。
     */
    accept(state) {
      if (expired(current)) {
        current = null
        return { ok: false, reason: 'no-session' }
      }
      if (typeof state !== 'string' || state === '' || state !== current.state) {
        return { ok: false, reason: 'state-mismatch' }
      }
      return { ok: true, session: { ...current } }
    },
    /** 消费掉会话（成功或失败都要清，避免重放）。 */
    clear() {
      current = null
    },
  }
}
