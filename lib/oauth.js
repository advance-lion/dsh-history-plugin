/**
 * 百度网盘 OAuth：授权码换 token + 自动刷新。
 *
 * ## 为什么需要它
 *
 * 临时 token（开放平台控制台签发的短期凭证）会过期，过期后同步会静默失败，
 * 用户只能重新粘贴。OAuth 带来的是 `refresh_token`：过期前自动换新的，
 * 装一次、授权一次，之后长期可用。
 *
 * ## 端点是实测确认的，不是照文档抄的
 *
 * 用一个不存在的 client_id 探过（无凭据、无副作用）：
 *
 *   GET /oauth/2.0/token?grant_type=authorization_code&...&client_id=probe
 *     → 401 {"error":"invalid_client","error_description":"unknown client id"}
 *   说明端点存在、参数名就是 `grant_type` / `client_id` / `client_secret`，
 *   而且 **GET + 查询串** 就能把参数送到（它读出了 client_id 才报 unknown client）。
 *
 *   GET /oauth/2.0/authorize?...  → 200 text/html，标题「与百度连接」
 *   即：授权页就是百度自己的登录页，**扫码登录发生在那一页**，本插件不需要
 *   自己实现扫码。
 *
 *   GET /oauth/2.0/device/code → 200，但演示应用没有可用于换 token 的 client_secret；
 *   设备码换 token 会因缺少必需参数被拒绝，所以这里不提供假装能用的分支。
 *
 * ## 扫码与客户端身份
 *
 * 扫码能不能用，取决于有没有一个**注册过的应用**：OAuth 里客户端身份不能匿名，
 * authorize 页要先知道「哪个应用在请求授权」。所以流程是：注册应用 → 配 AppKey/
 * SecretKey/回调地址 → 打开 authorize 页（在那里扫码登录）→ 拿到 code → 换 token。
 *
 * 本模块只做协议部分：拼 URL、换 token、刷新、判断是否需要刷新。
 * token 的存放由调用方负责（本插件走 DSH 凭据服务），**这里的任何错误消息都不含密钥**。
 */

/** 授权页。用户在这里登录（可扫码），随后被重定向回 `redirectUri` 并带上 `code`。 */
export const AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize'
/** 换取/刷新 token 的端点。 */
export const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
/** 网盘所需的授权范围。 */
export const DEFAULT_SCOPE = 'basic,netdisk'
/**
 * 提前多久算「该刷新了」。十分钟足够覆盖一次同步的往返，
 * 又不会让每次同步都去换 token。
 */
export const REFRESH_SKEW_MS = 10 * 60 * 1000
/** 单次请求超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** OAuth 相关的失败。消息里永远不会出现 token。 */
export class OAuthError extends Error {
  /**
   * @param {string} message 可读消息。
   * @param {{ code?: string|null, status?: number|null, step?: string|null }} [details] 细节。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'OAuthError'
    this.code = details.code ?? null
    this.status = details.status ?? null
    this.step = details.step ?? null
  }
}

/**
 * 拼授权页 URL。
 * @param {{ appKey: string, redirectUri: string, scope?: string, state?: string|null }} params 参数。
 * @returns {string} 要交给浏览器打开的 URL。
 */
export function buildAuthorizeUrl(params) {
  const appKey = typeof params?.appKey === 'string' ? params.appKey.trim() : ''
  const redirectUri = typeof params?.redirectUri === 'string' ? params.redirectUri.trim() : ''
  if (appKey === '') throw new OAuthError('缺少 AppKey（开放平台应用的 API Key）', { step: 'authorize-url' })
  if (redirectUri === '') throw new OAuthError('缺少回调地址（必须与开放平台里登记的完全一致）', { step: 'authorize-url' })
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', appKey)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', typeof params.scope === 'string' && params.scope !== '' ? params.scope : DEFAULT_SCOPE)
  // state 原样带回，用来防跨站请求伪造；不传就不带这个参数。
  if (typeof params.state === 'string' && params.state !== '') url.searchParams.set('state', params.state)
  return url.toString()
}

/**
 * 从「用户粘贴的东西」里取出授权码。
 *
 * 用户拿到的可能是一整条回调 URL（浏览器跳到回调地址后的地址栏内容），
 * 也可能只是 code 本身。回调地址通常会打不开（还没起本地服务），所以直接粘
 * 整条 URL 是最顺手的用法，这里两种都支持。
 * @param {string} input 粘贴内容。
 * @returns {string|null} 授权码。
 */
export function extractCode(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '') return null
  if (text.includes('://') || text.includes('code=')) {
    try {
      const url = new URL(text.startsWith('http') ? text : `http://placeholder/?${text.replace(/^\?/, '')}`)
      const code = url.searchParams.get('code')
      if (typeof code === 'string' && code !== '') return code
    } catch {
      /* 不是 URL，往下按裸 code 处理。 */
    }
  }
  // 裸 code：不含空白与 & 的一段。
  if (/^[A-Za-z0-9._~+/=-]+$/.test(text)) return text
  return null
}

/**
 * 调 token 端点。
 *
 * 用 GET + 查询串：这是实测确认能送达参数的方式（探针里端点读出了 client_id）。
 * @param {object} params 参数。
 * @returns {Promise<object>} 端点返回的 JSON。
 */
async function callTokenEndpoint(params) {
  const url = new URL(params.url ?? TOKEN_URL)
  for (const [key, value] of Object.entries(params.query)) {
    if (value !== null && value !== undefined && String(value) !== '') url.searchParams.set(key, String(value))
  }
  const fetchImpl = params.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } })
  } catch (error) {
    throw new OAuthError(`连不上百度授权服务：${error?.message ?? error}`, { step: params.step })
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    throw new OAuthError(`授权服务返回的不是 JSON（HTTP ${response.status}）`, { status: response.status, step: params.step })
  }
  if (body === null || typeof body !== 'object') {
    throw new OAuthError(`授权服务返回了空响应（HTTP ${response.status}）`, { status: response.status, step: params.step })
  }
  if (typeof body.error === 'string' && body.error !== '') {
    // error_description 是百度给的可读原因（例如 invalid_client / invalid_grant）。
    const detail = typeof body.error_description === 'string' && body.error_description !== '' ? body.error_description : body.error
    throw new OAuthError(`${params.step === 'refresh' ? '刷新授权失败' : '换取授权失败'}：${detail}`, {
      code: body.error,
      status: response.status,
      step: params.step,
    })
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new OAuthError('授权服务没有返回 access_token', { status: response.status, step: params.step })
  }
  return body
}

/**
 * 把端点响应收敛成 grant。
 * @param {object} body 端点响应。
 * @param {number} now 当前毫秒时间戳。
 * @returns {object} grant。
 */
function grantFromBody(body, now) {
  const expiresIn = Number(body.expires_in)
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : null,
    // 绝对时间戳；拿不到 expires_in 就记 null（表示不知道，不猜）。
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
    uk: null,
    baiduName: null,
  }
}

/**
 * 用授权码换 token。
 * @param {object} params 参数。
 * @returns {Promise<object>} grant。
 */
export async function exchangeCode(params) {
  const appKey = typeof params?.appKey === 'string' ? params.appKey.trim() : ''
  const secretKey = typeof params?.secretKey === 'string' ? params.secretKey.trim() : ''
  const code = extractCode(params?.code)
  if (appKey === '' || secretKey === '') throw new OAuthError('缺少 AppKey / SecretKey', { step: 'exchange' })
  if (code === null) throw new OAuthError('没有拿到有效的授权码：请粘贴回调地址整条 URL，或其中的 code 参数', { step: 'exchange' })
  const body = await callTokenEndpoint({
    step: 'exchange',
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    query: {
      grant_type: 'authorization_code',
      code,
      client_id: appKey,
      client_secret: secretKey,
      redirect_uri: params.redirectUri,
    },
  })
  return grantFromBody(body, typeof params.now === 'number' ? params.now : Date.now())
}

/**
 * 用 refresh_token 换新的 access_token。
 * @param {object} params 参数。
 * @returns {Promise<object>} 新的 grant（若端点没返回新的 refresh_token，则为 null，调用方应沿用旧的）。
 */
export async function refreshAccessToken(params) {
  const appKey = typeof params?.appKey === 'string' ? params.appKey.trim() : ''
  const secretKey = typeof params?.secretKey === 'string' ? params.secretKey.trim() : ''
  const refreshToken = typeof params?.refreshToken === 'string' ? params.refreshToken.trim() : ''
  if (appKey === '' || secretKey === '') throw new OAuthError('缺少 AppKey / SecretKey', { step: 'refresh' })
  if (refreshToken === '') throw new OAuthError('没有 refresh_token，无法自动刷新，请重新授权', { step: 'refresh' })
  const body = await callTokenEndpoint({
    step: 'refresh',
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    query: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: secretKey,
    },
  })
  return grantFromBody(body, typeof params.now === 'number' ? params.now : Date.now())
}

/**
 * 是否该刷新了。
 *
 * `expiresAt` 为 null 表示不知道过期时间（例如环境变量里给的临时 token），
 * 这种情况不主动刷新——没有依据就不动它。
 * @param {object|null} grant 授权。
 * @param {{ now?: number, skewMs?: number }} [options] 选项。
 * @returns {boolean} 是否需要刷新。
 */
export function needsRefresh(grant, options = {}) {
  if (grant === null || typeof grant !== 'object') return false
  if (!Number.isFinite(grant.expiresAt)) return false
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const skew = typeof options.skewMs === 'number' ? options.skewMs : REFRESH_SKEW_MS
  return grant.expiresAt - now <= skew
}

/**
 * 是否已经**确实过期**（不是「快过期」）。
 * 已过期且刷新失败时，同步必须停下并明确要求重新授权，而不是拿一个废 token 去撞墙。
 * @param {object|null} grant 授权。
 * @param {number} [now] 当前毫秒时间戳。
 * @returns {boolean} 是否已过期。
 */
export function isExpired(grant, now = Date.now()) {
  if (grant === null || typeof grant !== 'object') return false
  if (!Number.isFinite(grant.expiresAt)) return false
  return grant.expiresAt <= now
}

/**
 * 建立一个 token 保管者：同步前调一次 `ensureFresh()`，需要刷新就刷新并写回。
 *
 * 不抛异常：返回结果对象，让调用方决定是「继续用当前 token」还是「停下要求重新授权」。
 * 刷新失败但 token 还没过期时继续用——多一次成功同步比多一次误报有用。
 * 已过期又刷不出来时明确标记 `expired`，让上层给出可操作的提示。
 *
 * @param {{ readGrant: () => Promise<object|null>, writeGrant: (grant: object) => Promise<unknown>, getAppKeys: () => { appKey: string|null, secretKey: string|null }, fetchImpl?: any, now?: () => number, onWarn?: (message: string) => void }} options 依赖。
 * @returns {{ ensureFresh: () => Promise<object> }} 保管者。
 */
export function createTokenKeeper(options) {
  const now = options.now ?? (() => Date.now())
  const onWarn = options.onWarn ?? (() => {})

  /**
   * 确保当前 token 可用。
   * @returns {Promise<{ ok: boolean, refreshed?: boolean, expired?: boolean, reason?: string, message?: string }>} 结果。
   */
  async function ensureFresh() {
    const current = await options.readGrant()
    if (current === null || current.grant === null) return { ok: false, reason: 'unconfigured' }
    const grant = current.grant
    if (!needsRefresh(grant, { now: now() })) return { ok: true, refreshed: false }

    const keys = options.getAppKeys()
    const appKey = typeof keys?.appKey === 'string' ? keys.appKey.trim() : ''
    const secretKey = typeof keys?.secretKey === 'string' ? keys.secretKey.trim() : ''
    if (appKey === '' || secretKey === '') {
      const expired = isExpired(grant, now())
      const message = expired
        ? '授权已过期：请填写开放平台应用的 AppKey/SecretKey 以支持自动刷新，或重新授权'
        : '授权即将过期，但没配 AppKey/SecretKey 无法自动刷新；过期后需要重新授权'
      onWarn(message)
      return expired ? { ok: false, expired: true, reason: 'no-app-keys', message } : { ok: true, refreshed: false }
    }

    try {
      const refreshed = await refreshAccessToken({
        appKey,
        secretKey,
        refreshToken: grant.refreshToken,
        fetchImpl: options.fetchImpl,
        now: now(),
      })
      const merged = {
        ...grant,
        ...refreshed,
        // 端点没给新的 refresh_token 时沿用旧的，否则下次就没得刷了。
        refreshToken: refreshed.refreshToken ?? grant.refreshToken,
        // 账号标识刷不出来，沿用已有的，免得缓存命名空间丢失。
        uk: refreshed.uk ?? grant.uk,
        baiduName: refreshed.baiduName ?? grant.baiduName,
      }
      await options.writeGrant(merged)
      return { ok: true, refreshed: true }
    } catch (error) {
      const message = error?.message ?? String(error)
      const expired = isExpired(grant, now())
      onWarn(`刷新授权失败：${message}`)
      return expired
        ? { ok: false, expired: true, reason: 'refresh-failed', message }
        : { ok: true, refreshed: false }
    }
  }

  return { ensureFresh }
}
