/**
 * 一键授权（百度公开演示应用 + 隐式流程）的离线断言。
 *
 * 全部不联网：只验证拼出来的授权页地址、从各种形态里提取 token、以及一次性会话
 * 的 state/过期/重放行为。真实授权页长什么样由「用户点一次」来验证（见 README）。
 *
 * 运行：node scripts/authflow-smoke.mjs
 */

import {
  DEMO_APP_KEY,
  DEMO_REDIRECT_URI,
  SESSION_TTL_MS,
  buildCodeAuthorizeUrl,
  buildImplicitAuthorizeUrl,
  createAuthSessions,
  extractToken,
  implicitGrant,
} from '../lib/authflow.js'

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n== ${title} ==`)
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const TOKEN = 'a'.repeat(32)
const CALLBACK = 'http://127.0.0.1:19387/dsh-history-plugin/api/v1/oauth/redirect'

section('授权页地址')
{
  const implicit = buildImplicitAuthorizeUrl({ redirectUri: CALLBACK, state: 'st123' })
  check('隐式流程用 response_type=token', implicit.includes('response_type=token'), implicit)
  check('用百度公开演示应用（用户无需注册）', implicit.includes(`client_id=${DEMO_APP_KEY}`))
  check('演示应用强制 redirect_uri=oob（否则百度报 redirect_uri_mismatch）', implicit.includes(`redirect_uri=${DEMO_REDIRECT_URI}`), implicit)
  check('演示应用地址里不出现本机回调', !implicit.includes('127.0.0.1'), implicit)
  check('带 state 防串号', implicit.includes('state=st123'))
  check('scope 含 netdisk', implicit.includes('scope=basic%2Cnetdisk'))
  check('不带任何密钥', !/secret/i.test(implicit), implicit)
  const explicitDemo = buildImplicitAuthorizeUrl({ appKey: DEMO_APP_KEY, redirectUri: CALLBACK })
  check('显式写演示应用也覆盖成本机以外的 oob', explicitDemo.includes(`redirect_uri=${DEMO_REDIRECT_URI}`) && !explicitDemo.includes('127.0.0.1'), explicitDemo)
  const own = buildImplicitAuthorizeUrl({ appKey: 'own-key', redirectUri: CALLBACK })
  check('可换成自己的应用', own.includes('client_id=own-key'))
  check('自己的应用仍可用已登记的回调地址', own.includes('client_id=own-key') && own.includes('redirect_uri=http%3A%2F%2F127.0.0.1%3A19387%2F'), own)
  check('没有 state 时不硬塞空参数', !own.includes('state='), own)
  const code = buildCodeAuthorizeUrl({ appKey: 'own-key', redirectUri: CALLBACK, state: 's2' })
  check('授权码流程用 response_type=code', code.includes('response_type=code') && code.includes('client_id=own-key'))
  const demoCode = buildCodeAuthorizeUrl({ redirectUri: CALLBACK })
  check('演示应用的授权码流程也被锁到 oob（高级路径必须显式给 AppKey）', demoCode.includes(`redirect_uri=${DEMO_REDIRECT_URI}`) && !demoCode.includes('127.0.0.1'), demoCode)
}

section('token 提取（用户可能要手工兜底粘贴）')
{
  const fragment = extractToken(`https://openapi.baidu.com/oauth/2.0/login_success#access_token=${TOKEN}&expires_in=2592000&scope=basic`)
  check('从百度成功页片段提取', fragment.ok === true && fragment.token === TOKEN, JSON.stringify(fragment).slice(0, 120))
  check('顺带读出有效期', fragment.expiresIn === 2592000, String(fragment.expiresIn))
  check('从查询串提取', extractToken(`http://127.0.0.1:19387/cb?access_token=${TOKEN}`).token === TOKEN)
  check('贴片段本身', extractToken(`access_token=${TOKEN}`).token === TOKEN)
  check('贴 token 本身', extractToken(TOKEN).token === TOKEN)
  check('JSON 形态', extractToken(JSON.stringify({ access_token: TOKEN })).token === TOKEN)
  check('前后空白被容忍', extractToken(`  ${TOKEN}  `).token === TOKEN)
  check('空输入被拒', extractToken('   ').ok === false)
  check('只有 code 时明确报缺 token', extractToken('https://x/cb?code=abc').reason === 'no-token')
  check('畸形 token 被拒', extractToken('access_token=short').ok === false)
  check('超长输入被拒', extractToken(`access_token=${'a'.repeat(5000)}`).ok === false)
  check('非字符串输入不崩', extractToken(null).ok === false && extractToken(12345).ok === false)
}

section('隐式流程的凭据形状')
{
  const NOW = 1_700_000_000_000
  const parsed = extractToken(`https://openapi.baidu.com/oauth/2.0/login_success#access_token=${TOKEN}&expires_in=2592000`)
  const grant = implicitGrant(parsed, { now: () => NOW })
  check('隐式授权保存绝对毫秒过期时间', grant.expiresAt === NOW + 2592000 * 1000, String(grant.expiresAt))
  check('隐式授权不伪造 refresh_token', grant.refreshToken === null)
  check('隐式授权带默认网盘 scope', grant.scope === 'basic,netdisk')
  check('没有 expires_in 时不猜过期时间', implicitGrant(extractToken(`access_token=${TOKEN}`), { now: () => NOW }).expiresAt === null)
  let threw = false
  try {
    implicitGrant({ ok: false, reason: 'no-token' })
  } catch {
    threw = true
  }
  check('提取失败时拒绝造 grant', threw)
}

section('一次性授权会话')
{
  let clock = 1_000_000
  const sessions = createAuthSessions({ ttlMs: 1000, now: () => clock, randomState: () => 'fixed-state' })
  check('未开会话时没有会话', sessions.peek() === null)
  const started = sessions.start({ redirectUri: CALLBACK })
  check('开会话返回 state 与授权地址', started.state === 'fixed-state' && started.authorizeUrl.includes('response_type=token'), JSON.stringify(started).slice(0, 120))
  check('演示应用会话记录的是 oob 回调', started.redirectUri === DEMO_REDIRECT_URI, String(started.redirectUri))
  check('会话带 ISO 过期时间', typeof started.expiresAt === 'string' && started.expiresAt.endsWith('Z'))
  check('默认模式是隐式', started.mode === 'implicit', String(started.mode))
  check('有效期内会话可见', sessions.peek() !== null)
  check('state 不对就拒绝', sessions.accept('wrong').ok === false && sessions.accept('wrong').reason === 'state-mismatch')
  check('少了 state 也拒绝', sessions.accept(undefined).ok === false)
  check('state 对了才接受', sessions.accept('fixed-state').ok === true)
  check('接受不等于消费（还可再查）', sessions.peek() !== null)
  sessions.clear()
  check('消费后不能重放', sessions.accept('fixed-state').ok === false)
  const expiring = sessions.start({ redirectUri: CALLBACK })
  clock += 5000
  check('过期即视为不存在', sessions.peek() === null)
  check('过期后提交一律拒绝（不留假状态）', sessions.accept(expiring.state).ok === false && sessions.accept(expiring.state).reason === 'no-session')
  check('默认有效期是 10 分钟', SESSION_TTL_MS === 10 * 60 * 1000, String(SESSION_TTL_MS))
  const again = sessions.start({ redirectUri: CALLBACK })
  check('过期后可以重新开会话', again.state === 'fixed-state' && sessions.peek() !== null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
