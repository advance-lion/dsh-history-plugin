/**
 * OAuth 模块测试：全程对着**假授权服务器**跑，不联网。
 *
 * 真实验证必须等用户注册开放平台应用拿到 AppKey/SecretKey；这个套件保证的是
 * 协议部分与刷新逻辑本身是对的，尤其是几条硬要求：
 *   - 请求组装正确（参数名照实测来的 `grant_type` / `client_id` / `client_secret`）
 *   - 刷新**只在快过期时**发生，不过期就一个请求都不发
 *   - 刷新返回没带新 refresh_token 时**沿用旧的**（否则下次就没得刷了）
 *   - 账号标识（uk）与缓存命名空间在刷新后不丢
 *   - **任何错误消息、告警里都不出现密钥**（secretKey / refresh_token）
 *
 * 用法：node scripts/oauth-smoke.mjs
 */

import {
  AUTHORIZE_URL,
  DEFAULT_SCOPE,
  OAuthError,
  REFRESH_SKEW_MS,
  buildAuthorizeUrl,
  createTokenKeeper,
  exchangeCode,
  extractCode,
  isExpired,
  needsRefresh,
  refreshAccessToken,
} from '../lib/oauth.js'

let passed = 0
let failed = 0
const section = title => console.log(`\n== ${title} ==`)
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const APP_KEY = 'probe-app-key'
const SECRET = 'super-secret-key-do-not-leak'
const REFRESH = 'refresh-token-do-not-leak'
const NOW = Date.UTC(2026, 9, 13, 6, 0, 0)

/** 假授权服务器：记录收到的请求，按脚本返回。 */
function makeServer(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url))
    calls.push({ url: parsed, init })
    const body = typeof script === 'function' ? script(calls.length, parsed) : script
    if (body === null) throw new Error('模拟网络故障')
    return {
      status: body.__status ?? 200,
      headers: { get: () => 'application/json' },
      text: async () => (typeof body.__text === 'string' ? body.__text : JSON.stringify(body)),
    }
  }
  return { calls, fetchImpl }
}

const successBody = (extra = {}) => ({
  access_token: 'fresh-access-token',
  expires_in: 2_592_000,
  refresh_token: REFRESH,
  scope: DEFAULT_SCOPE,
  ...extra,
})

/* ------------------------------------------------------------ 授权页 URL */
section('授权页 URL')
{
  const url = new URL(buildAuthorizeUrl({ appKey: APP_KEY, redirectUri: 'https://example.com/cb', state: 'xyz' }))
  check('指向百度授权页', url.origin + url.pathname === AUTHORIZE_URL, url.origin + url.pathname)
  check('response_type=code', url.searchParams.get('response_type') === 'code')
  check('带上了 client_id', url.searchParams.get('client_id') === APP_KEY)
  check('带上了回调地址', url.searchParams.get('redirect_uri') === 'https://example.com/cb')
  check('默认范围是 basic,netdisk', url.searchParams.get('scope') === DEFAULT_SCOPE, String(url.searchParams.get('scope')))
  check('带上了 state', url.searchParams.get('state') === 'xyz')
  check('URL 里不含任何密钥', !buildAuthorizeUrl({ appKey: APP_KEY, redirectUri: 'https://example.com/cb' }).includes(SECRET))

  let missingKey = null
  try {
    buildAuthorizeUrl({ appKey: '', redirectUri: 'https://example.com/cb' })
  } catch (error) {
    missingKey = error
  }
  check('缺 AppKey 时报错', missingKey instanceof OAuthError && missingKey.step === 'authorize-url', String(missingKey?.message))

  let missingRedirect = null
  try {
    buildAuthorizeUrl({ appKey: APP_KEY, redirectUri: '' })
  } catch (error) {
    missingRedirect = error
  }
  check('缺回调地址时报错', missingRedirect instanceof OAuthError, String(missingRedirect?.message))
}

/* --------------------------------------------------------------- 取授权码 */
section('从粘贴内容里取授权码')
{
  check('整条回调 URL', extractCode('https://example.com/cb?code=abc123&state=xyz') === 'abc123')
  check('带 ? 的查询串', extractCode('?code=abc123&state=xyz') === 'abc123')
  check('裸 code', extractCode('  abc123  ') === 'abc123')
  check('空输入', extractCode('') === null)
  check('乱输入', extractCode('这不是一个授权码！') === null)
  check('没有 code 的 URL', extractCode('https://example.com/cb?error=access_denied') === null)
}

/* ------------------------------------------------------------ 换取 token */
section('授权码换 token')
{
  const server = makeServer(successBody())
  const grant = await exchangeCode({
    appKey: APP_KEY,
    secretKey: SECRET,
    code: 'https://example.com/cb?code=the-code',
    redirectUri: 'https://example.com/cb',
    fetchImpl: server.fetchImpl,
    now: NOW,
  })
  const query = server.calls[0].url.searchParams
  check('打到 token 端点', server.calls[0].url.pathname === '/oauth/2.0/token', server.calls[0].url.pathname)
  check('用 GET + 查询串（实测确认能送达参数）', server.calls[0].init?.method === 'GET')
  check('grant_type=authorization_code', query.get('grant_type') === 'authorization_code')
  check('从整条 URL 里解出了 code', query.get('code') === 'the-code', String(query.get('code')))
  check('带上了 client_id 与 client_secret', query.get('client_id') === APP_KEY && query.get('client_secret') === SECRET)
  check('带上了 redirect_uri', query.get('redirect_uri') === 'https://example.com/cb')
  check('解析出 access_token', grant.accessToken === 'fresh-access-token')
  check('解析出 refresh_token', grant.refreshToken === REFRESH)
  check('过期时间换算成绝对时间戳', grant.expiresAt === NOW + 2_592_000 * 1000, String(grant.expiresAt))
  check('带上 scope', grant.scope === DEFAULT_SCOPE)
  check('不带出任何多余字段', Object.keys(grant).sort().join(',') === 'accessToken,baiduName,expiresAt,refreshToken,scope,uk', Object.keys(grant).join(','))

  let badCode = null
  try {
    await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: '', redirectUri: 'x', fetchImpl: server.fetchImpl })
  } catch (error) {
    badCode = error
  }
  check('没有有效授权码时报错', badCode instanceof OAuthError && badCode.step === 'exchange', String(badCode?.message))

  check('没有 expires_in 时不猜过期时间',
    (await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: 'c', redirectUri: 'x', fetchImpl: makeServer({ access_token: 't', refresh_token: 'r' }).fetchImpl })).expiresAt === null)
}

/* ------------------------------------------------------------ 换取的错误 */
section('错误如实转述，且不泄露密钥')
{
  const server = makeServer({ error: 'invalid_client', error_description: 'unknown client id', __status: 401 })
  let error = null
  try {
    await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: 'c', redirectUri: 'x', fetchImpl: server.fetchImpl })
  } catch (caught) {
    error = caught
  }
  check('错误类型正确', error instanceof OAuthError)
  check('带上了 error code', error?.code === 'invalid_client', String(error?.code))
  check('转述了百度的可读原因', String(error?.message).includes('unknown client id'), String(error?.message))
  check('错误消息里没有 client_secret', !String(error?.message).includes(SECRET))
  check('错误消息里没有 code 本体', !String(error?.message).includes('code=c'))

  const html = makeServer({ __text: '<html>与百度连接</html>' })
  let notJson = null
  try {
    await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: 'c', redirectUri: 'x', fetchImpl: html.fetchImpl })
  } catch (caught) {
    notJson = caught
  }
  check('返回非 JSON 时给出可读错误', notJson instanceof OAuthError && String(notJson.message).includes('不是 JSON'), String(notJson?.message))

  const dead = makeServer(() => null)
  let offline = null
  try {
    await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: 'c', redirectUri: 'x', fetchImpl: dead.fetchImpl })
  } catch (caught) {
    offline = caught
  }
  check('网络故障时给出可读错误', offline instanceof OAuthError && String(offline.message).includes('连不上'), String(offline?.message))

  const noToken = makeServer({ expires_in: 100 })
  let empty = null
  try {
    await exchangeCode({ appKey: APP_KEY, secretKey: SECRET, code: 'c', redirectUri: 'x', fetchImpl: noToken.fetchImpl })
  } catch (caught) {
    empty = caught
  }
  check('没返回 access_token 时报错', empty instanceof OAuthError && String(empty.message).includes('access_token'), String(empty?.message))
}

/* ---------------------------------------------------------------- 刷新 */
section('刷新 token')
{
  const server = makeServer(successBody({ access_token: 'rotated-token' }))
  const grant = await refreshAccessToken({ appKey: APP_KEY, secretKey: SECRET, refreshToken: REFRESH, fetchImpl: server.fetchImpl, now: NOW })
  const query = server.calls[0].url.searchParams
  check('grant_type=refresh_token', query.get('grant_type') === 'refresh_token')
  check('带上了 refresh_token', query.get('refresh_token') === REFRESH)
  check('带上了 client_id 与 client_secret', query.get('client_id') === APP_KEY && query.get('client_secret') === SECRET)
  check('拿到新 access_token', grant.accessToken === 'rotated-token')

  const noRotation = await refreshAccessToken({
    appKey: APP_KEY,
    secretKey: SECRET,
    refreshToken: REFRESH,
    fetchImpl: makeServer({ access_token: 'x', expires_in: 100 }).fetchImpl,
    now: NOW,
  })
  check('端点没给新 refresh_token 时为 null（交由调用方沿用旧的）', noRotation.refreshToken === null)

  let noRefresh = null
  try {
    await refreshAccessToken({ appKey: APP_KEY, secretKey: SECRET, refreshToken: '', fetchImpl: server.fetchImpl })
  } catch (error) {
    noRefresh = error
  }
  check('没有 refresh_token 时明确报错', noRefresh instanceof OAuthError && String(noRefresh.message).includes('重新授权'), String(noRefresh?.message))
}

/* ------------------------------------------------------- 该不该刷新 */
section('什么时候刷新')
{
  check('不知道过期时间就不动它', needsRefresh({ expiresAt: null }) === false)
  check('还早就不刷', needsRefresh({ expiresAt: NOW + 3_600_000 }, { now: NOW }) === false)
  check('进入提前量就刷', needsRefresh({ expiresAt: NOW + REFRESH_SKEW_MS - 1 }, { now: NOW }) === true)
  check('刚好到提前量边界就刷', needsRefresh({ expiresAt: NOW + REFRESH_SKEW_MS }, { now: NOW }) === true)
  check('已过期算过期', isExpired({ expiresAt: NOW - 1 }, NOW) === true)
  check('还没过期不算过期', isExpired({ expiresAt: NOW + 1 }, NOW) === false)
  check('不知道过期时间不算已过期', isExpired({ expiresAt: null }, NOW) === false)
}

/* ------------------------------------------------------- token 保管者 */
section('token 保管者')
{
  /** 造一个保管者，记录写回内容。 */
  function keeper(grant, keys, server) {
    const warnings = []
    const written = []
    return {
      warnings,
      written,
      handle: createTokenKeeper({
        readGrant: async () => (grant === null ? null : { grant, source: 'credentials' }),
        writeGrant: async next => {
          written.push(next)
        },
        getAppKeys: () => keys,
        fetchImpl: server.fetchImpl,
        now: () => NOW,
        onWarn: message => warnings.push(message),
      }),
    }
  }

  const noGrant = keeper(null, { appKey: APP_KEY, secretKey: SECRET }, makeServer(successBody()))
  check('没授权时如实报 unconfigured', (await noGrant.handle.ensureFresh()).reason === 'unconfigured')

  const freshServer = makeServer(successBody())
  const fresh = keeper({ accessToken: 'still-good', refreshToken: REFRESH, expiresAt: NOW + 86_400_000 }, { appKey: APP_KEY, secretKey: SECRET }, freshServer)
  const freshResult = await fresh.handle.ensureFresh()
  check('没过期就什么都不做', freshResult.ok === true && freshResult.refreshed === false)
  check('没过期时一个请求都不发', freshServer.calls.length === 0, String(freshServer.calls.length))
  check('没过期时不写回凭据', fresh.written.length === 0)

  const emptyServer = makeServer(successBody())
  const expiring = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW + 60_000, uk: '2269', baiduName: '超爱空空宝贝' }, { appKey: APP_KEY, secretKey: SECRET }, emptyServer)
  const expiringResult = await expiring.handle.ensureFresh()
  check('快过期时确实刷新了', expiringResult.ok === true && expiringResult.refreshed === true)
  check('刷新发了一个请求', emptyServer.calls.length === 1, String(emptyServer.calls.length))
  check('刷新后写回了凭据', expiring.written.length === 1)
  check('写回的是新 token', expiring.written[0]?.accessToken === 'fresh-access-token', String(expiring.written[0]?.accessToken))
  check('新过期时间被记下', expiring.written[0]?.expiresAt === NOW + 2_592_000 * 1000)
  check('账号标识没丢', expiring.written[0]?.uk === '2269' && expiring.written[0]?.baiduName === '超爱空空宝贝')

  const keepOldRefresh = makeServer({ access_token: 'rotated', expires_in: 1000 })
  const rotate = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW + 1000 }, { appKey: APP_KEY, secretKey: SECRET }, keepOldRefresh)
  await rotate.handle.ensureFresh()
  check('端点没给新 refresh_token 时沿用旧的', rotate.written[0]?.refreshToken === REFRESH, String(rotate.written[0]?.refreshToken))

  const noKeys = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW + 60_000 }, { appKey: '', secretKey: '' }, makeServer(successBody()))
  const noKeysResult = await noKeys.handle.ensureFresh()
  check('快过期但没配 AppKey 时继续用（不误报）', noKeysResult.ok === true && noKeysResult.refreshed === false)
  check('并且给出告警', noKeys.warnings.length === 1, JSON.stringify(noKeys.warnings))

  const expiredNoKeys = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW - 1000 }, { appKey: '', secretKey: '' }, makeServer(successBody()))
  const expiredNoKeysResult = await expiredNoKeys.handle.ensureFresh()
  check('已过期又没配 AppKey 时明确要求重新授权', expiredNoKeysResult.ok === false && expiredNoKeysResult.expired === true, JSON.stringify(expiredNoKeysResult))

  const refreshBroken = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW - 1000 }, { appKey: APP_KEY, secretKey: SECRET }, makeServer({ error: 'invalid_grant', error_description: 'refresh token expired', __status: 400 }))
  const brokenResult = await refreshBroken.handle.ensureFresh()
  check('已过期且刷新失败时停下载明原因', brokenResult.ok === false && brokenResult.expired === true && brokenResult.reason === 'refresh-failed', JSON.stringify(brokenResult))

  const stillValid = keeper({ accessToken: 'old', refreshToken: REFRESH, expiresAt: NOW + 60_000 }, { appKey: APP_KEY, secretKey: SECRET }, makeServer({ error: 'server_error', error_description: 'boom', __status: 500 }))
  const stillValidResult = await stillValid.handle.ensureFresh()
  check('刷新失败但还没过期时继续用', stillValidResult.ok === true && stillValidResult.refreshed === false, JSON.stringify(stillValidResult))

  const allWarnings = [...noKeys.warnings, ...expiredNoKeys.warnings, ...refreshBroken.warnings, ...stillValid.warnings, ...expiring.warnings]
  check('告警里没有 client_secret', !allWarnings.join(' ').includes(SECRET), allWarnings.join(' | '))
  check('告警里没有 refresh_token', !allWarnings.join(' ').includes(REFRESH), allWarnings.join(' | '))
  const allResults = JSON.stringify([expiredNoKeysResult, brokenResult, stillValidResult, expiringResult])
  check('返回值里没有 client_secret', !allResults.includes(SECRET))
  check('返回值里没有 refresh_token 本体', !allResults.includes(REFRESH))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
