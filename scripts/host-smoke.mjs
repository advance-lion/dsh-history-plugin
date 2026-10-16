/**
 * 宿主半边集成测试：用假 Cordis 上下文驱动**真实的 `apply()`**。
 *
 * 覆盖的是「重启 DSH 之前必须确认」的那部分：
 *   - 路由是否按预期注册、路径与方法对不对
 *   - 宿主请求闸：拒绝时是否真的拒绝；闸门抛异常时是否**失败即关闭**
 *   - 改动类请求的同源校验、请求体上限
 *   - 凭据只进不出：存进去之后，任何响应里都不能出现 token
 *   - 采集 + 合并 + 批量重装（含 `restart-required` 要如实上报）
 *
 * 全部离线。真实网盘链路见 scripts/baidu-live.mjs。
 *
 * 用法：node scripts/host-smoke.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-history-host-'))
process.env.DSH_HOME = sandbox
const profileDir = join(sandbox, 'profiles', 'test')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'profile-test',
  version: '0.0.0',
  dependencies: {
    'dsh-image-gen': '^0.8.6',
    'dsh-pocket': '2.10.6',
    'dsh-local-kit': 'link:C:/somewhere/local-kit',
    'dsh-history-plugin': 'link:C:/Users/ORiSUNG/Documents/deepseek-harness/dsh-history-plugin',
  },
}, null, 2), 'utf8')
process.env.DSH_PROFILE_DIR = profileDir

const plugin = await import('../lib/index.js')

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

/* ------------------------------------------------------------ 假的宿主 */

const SECRET = 'baidu-token-super-secret-9f8e7d6c'

/** 假请求：必须可异步迭代，readJsonBody 靠它读体。 */
function makeRequest({ method = 'GET', headers = {}, body = null, host = '127.0.0.1:19387' } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const all = { host, ...headers }
  return {
    method,
    url: '/',
    headers: all,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 假响应。 */
function makeResponse() {
  const response = { status: 0, headers: null, payload: '' }
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? null
  }
  response.end = (payload = '') => {
    response.payload = typeof payload === 'string' ? payload : String(payload)
  }
  response.json = () => {
    try {
      return JSON.parse(response.payload)
    } catch {
      return null
    }
  }
  return response
}

const routes = []
const effects = []
const installs = []
const records = new Map()
const gate = { mode: 'open' }
const bundles = [
  { name: 'dsh-image-gen', version: '0.8.6', installed: true, removable: true, enabled: true },
  { name: 'dsh-pocket', version: '2.10.6', installed: true, removable: true, enabled: true },
  { name: 'dsh-local-kit', version: '0.1.0', installed: true, removable: true, enabled: true },
  { name: 'dsh-history-plugin', version: '0.1.0', installed: true, removable: true, enabled: true },
  { name: '@deepseek-ai/dsh-base', version: '0.2.0', installed: true, removable: false, enabled: true },
]

const services = {
  profileContext: { dir: profileDir },
  pluginManager: {
    listBundles: async () => bundles,
    listPlugins: async () => [],
    inspect: async spec => ({ status: 'accepted', kind: 'registry', bundle: true, name: String(spec).split('@')[0], version: '1.0.0' }),
    installBundle: async (spec, options) => {
      installs.push({ spec, requestId: options?.requestId })
      return { stage: 'install', target: spec, enabled: true, changed: true, application: 'restart-required' }
    },
    waitForInstall: async () => null,
  },
  credentials: {
    async readRecord(key) {
      return records.get(key)
    },
    async describeRecord(key) {
      return { configured: records.has(key), kind: records.get(key)?.kind, writable: true }
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
    async listRecords() {
      return [...records.keys()].map(key => ({ key }))
    },
  },
  connection: {
    trustedHosts: ['dsh.example.org'],
    requestRejection: () => {
      if (gate.mode === 'throw') throw new Error('闸门内部错误')
      return gate.mode === 'open' ? undefined : gate.mode
    },
  },
}
services.webServer = {
  register: route => {
    routes.push(route)
    return () => {}
  },
}

const ctx = {
  get: name => services[name],
  inject: (names, callback) => {
    if (names.every(name => services[name] !== undefined)) callback(ctx)
  },
  on: () => () => {},
  effect: fn => {
    const disposer = fn()
    effects.push(disposer)
  },
  webServer: services.webServer,
}

plugin.apply(ctx, { remoteDir: '/dsh-history-plugin-test' })

/** 按路径找注册的那一条（每个路径只注册一条，方法在内部区分）。 */
const handlerFor = path => routes.find(route => route.path === path)

/** 驱动一次请求并等响应写出。 */
async function call(method, path, options = {}) {
  const route = handlerFor(path)
  if (route === undefined) throw new Error(`没有注册这个路径：${path}`)
  const response = makeResponse()
  route.handler(makeRequest({ method, ...options }), response)
  for (let index = 0; index < 300 && response.status === 0; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return response
}

/** 等采集器把首轮核对跑完。 */
async function waitForHistory() {
  for (let index = 0; index < 200; index += 1) {
    const response = await call('GET', '/dsh-history-plugin/api/v1/history')
    const body = response.json()
    if (response.status === 200 && (body?.rows?.length ?? 0) > 0) return body
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return null
}

/* ------------------------------------------------------------------ 路由 */
section('路由注册')
{
  // 每个路径只注册一条：同路径注册两次会被后注册的覆盖（/credential 有 POST 与 DELETE）。
  const expected = [
    '/dsh-history-plugin/api/v1/status',
    '/dsh-history-plugin/api/v1/history',
    '/dsh-history-plugin/api/v1/devices',
    '/dsh-history-plugin/api/v1/sync',
    '/dsh-history-plugin/api/v1/reinstall',
    '/dsh-history-plugin/api/v1/credential',
    '/dsh-history-plugin/api/v1/oauth/authorize-url',
    '/dsh-history-plugin/api/v1/oauth/callback',
    '/dsh-history-plugin/api/v1/oauth/session',
    '/dsh-history-plugin/api/v1/oauth/redirect',
    '/dsh-history-plugin/api/v1/storage-test',
    '/dsh-history-plugin/api/v1/device',
  ]
  const actual = routes.map(route => route.path)
  check('注册了 12 条路由（每个路径一条）', routes.length === 12, actual.join(', '))
  check('路径全部符合预期', expected.every(item => actual.includes(item)), actual.join(', '))
  check('没有重复路径', new Set(actual).size === actual.length, actual.join(', '))
  check('每条路由都是精确匹配', routes.every(route => route.kind === 'exact'))
  check('注入后拿到了释放函数', effects.length >= 2, String(effects.length))

  // 重启后命令行无法调 API（闸门要登录会话），这条日志是现场证据，必须真的写出来。
  const log = readFileSync(join(sandbox, 'history-plugin', 'plugin.log'), 'utf8')
  check('记下了 http-api-ready 日志', log.includes('http-api-ready'), log.split('\n').slice(-3).join(' | '))
  check('日志里带上了路径数与方法数', /http-api-ready.*12 paths \/ 14 methods/.test(log), log.split('\n').filter(line => line.includes('http-api')).join(' | '))
  check('日志里没有 token', !log.includes(SECRET))
}

/* -------------------------------------------------------------- 请求闸门 */
section('宿主请求闸门')
{
  const statusPath = '/dsh-history-plugin/api/v1/status'
  gate.mode = 403
  const refused = await call('GET', statusPath)
  check('闸门拒绝 403 时如实返回 403', refused.status === 403, String(refused.status))
  check('被拒时没有返回任何状态数据', refused.json()?.sync === undefined, JSON.stringify(refused.json()))

  gate.mode = 401
  const unauthorized = await call('GET', statusPath)
  check('闸门拒绝 401 时如实返回 401', unauthorized.status === 401, String(unauthorized.status))

  gate.mode = 'throw'
  const broken = await call('GET', statusPath)
  check('闸门抛异常时失败即关闭（403）', broken.status === 403, String(broken.status))

  gate.mode = 'open'
  const allowed = await call('GET', statusPath)
  check('闸门放行时正常返回', allowed.status === 200, String(allowed.status))
}

/* -------------------------------------------------------- 方法 / 同源 / 体积 */
section('方法、同源与请求体')
{
  const syncPath = '/dsh-history-plugin/api/v1/sync'
  const wrongMethod = await call('GET', syncPath)
  check('方法不对返回 405', wrongMethod.status === 405, String(wrongMethod.status))
  check('405 带 allow 头', wrongMethod.headers?.allow === 'POST', JSON.stringify(wrongMethod.headers))

  const devicePath = '/dsh-history-plugin/api/v1/device'
  const crossSite = await call('POST', devicePath, {
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: { label: '坏人' },
  })
  check('跨站来源被拒', crossSite.status === 403, String(crossSite.status))

  const nullOrigin = await call('POST', devicePath, { headers: { origin: 'null' }, body: { label: 'x' } })
  check('Origin: null 被拒', nullOrigin.status === 403, String(nullOrigin.status))

  const otherPort = await call('POST', devicePath, { headers: { origin: 'http://127.0.0.1:1234' }, body: { label: 'x' } })
  check('同主机不同端口被拒', otherPort.status === 403, String(otherPort.status))

  const sameOrigin = await call('POST', devicePath, {
    headers: { origin: 'http://127.0.0.1:19387' },
    body: { label: '同源机器' },
  })
  check('同源改动请求放行', sameOrigin.status === 200, `${sameOrigin.status} ${sameOrigin.payload}`)

  const noOrigin = await call('POST', devicePath, { body: { label: '非浏览器客户端' } })
  check('无 Origin 的非浏览器客户端放行', noOrigin.status === 200, `${noOrigin.status} ${noOrigin.payload}`)

  const rebinding = await call('POST', devicePath, { host: 'evil.example', body: { label: 'x' } })
  check('Host 非回环且未声明时被拒（防 DNS rebinding）', rebinding.status === 403, String(rebinding.status))

  const trusted = await call('POST', devicePath, { host: 'dsh.example.org', body: { label: '已声明域名' } })
  check('宿主声明的域名放行', trusted.status === 200, `${trusted.status} ${trusted.payload}`)

  // 请求体超过上限：直接喂一个超长 body。
  const bigRoute = handlerFor('/dsh-history-plugin/api/v1/reinstall')
  const bigResponse = makeResponse()
  const bigRequest = makeRequest({ method: 'POST', body: { packages: ['x'.repeat(20 * 1024)] } })
  bigRoute.handler(bigRequest, bigResponse)
  for (let index = 0; index < 200 && bigResponse.status === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 5))
  check('请求体超限返回 400', bigResponse.status === 400, `${bigResponse.status} ${bigResponse.payload}`)
}

/* --------------------------------------------------- 凭据：只进不出 */
section('凭据只进不出')
{
  const credentialPath = '/dsh-history-plugin/api/v1/credential'
  const statusPath = '/dsh-history-plugin/api/v1/status'

  const saved = await call('POST', credentialPath, { body: { accessToken: SECRET } })
  check('保存授权成功', saved.status === 200 && saved.json()?.saved === true, `${saved.status} ${saved.payload}`)
  check('保存响应里没有 token', !saved.payload.includes(SECRET))
  check('token 存进了宿主的凭据记录', records.get('dsh-history-plugin/baidu-netdisk')?.payload?.accessToken === SECRET, [...records.keys()].join(','))
  check('记录的 kind 是 grant', records.get('dsh-history-plugin/baidu-netdisk')?.kind === 'grant')
  check('保存响应也没回传 refresh 等字段', saved.json()?.credential?.configured === true)
  const afterSave = await call('GET', statusPath)
  check('状态显示已授权', afterSave.json()?.credential?.configured === true)
  check('状态响应里没有 token', !afterSave.payload.includes(SECRET))

  // 设置页要显示「当前连的是哪个网盘账号」：只给显示名，不给 uk，更不给 token。
  const recordKey = 'dsh-history-plugin/baidu-netdisk'
  records.set(recordKey, { ...records.get(recordKey), payload: { ...records.get(recordKey)?.payload, baiduName: '超爱空空宝贝' } })
  const withAccount = await call('GET', statusPath)
  check('状态里带上了网盘账号显示名', withAccount.json()?.account?.netdiskName === '超爱空空宝贝', withAccount.payload.slice(0, 160))
  check('账号信息里没有 uk 也没有 token', !withAccount.payload.includes(SECRET) && !withAccount.payload.includes('"uk"'), withAccount.payload.slice(0, 200))

  const history = await call('GET', '/dsh-history-plugin/api/v1/history')
  check('历史响应里没有 token', !history.payload.includes(SECRET))
  const devices = await call('GET', '/dsh-history-plugin/api/v1/devices')
  check('设备响应里没有 token', !devices.payload.includes(SECRET))
  // 方案要求「启动、重连、打开历史页时再扫描一次」：GET /history 必须真的触发一次核对。
  const logAfterView = readFileSync(join(sandbox, 'history-plugin', 'plugin.log'), 'utf8')
  check('打开历史页触发了补扫（reason=view）', /"detail":"view: /.test(logAfterView),
    logAfterView.split('\n').filter(item => item.includes('reconcile')).slice(-3).join(' | ').slice(0, 260))

  const empty = await call('POST', credentialPath, { body: { accessToken: '   ' } })
  check('空 token 被拒', empty.status === 500 && String(empty.json()?.error).includes('access token'), `${empty.status} ${empty.payload}`)

  const cleared = await call('DELETE', credentialPath)
  check('清除授权成功', cleared.status === 200 && cleared.json()?.credential?.configured === false, cleared.payload)
  check('记录已删除', records.size === 0, [...records.keys()].join(','))
}

/* ------------------------------------------------------------- OAuth 接入 */
section('OAuth 接入（完全离线）')
{
  const authorizePath = '/dsh-history-plugin/api/v1/oauth/authorize-url'
  const callbackPath = '/dsh-history-plugin/api/v1/oauth/callback'

  const url = await call('POST', authorizePath, { body: { appKey: 'my-app-key', redirectUri: 'https://example.com/cb' } })
  const payload = url.json()
  check('能拼出授权页地址', url.status === 200 && typeof payload?.authorizeUrl === 'string', `${url.status} ${url.payload}`)
  check('地址指向百度授权页', String(payload?.authorizeUrl).startsWith('https://openapi.baidu.com/oauth/2.0/authorize'), String(payload?.authorizeUrl).slice(0, 64))
  check('带上了 client_id 与回调地址', String(payload?.authorizeUrl).includes('client_id=my-app-key') && String(payload?.authorizeUrl).includes('redirect_uri='))
  check('带上了 state（防 CSRF）', /[?&]state=/.test(String(payload?.authorizeUrl)), String(payload?.authorizeUrl))
  check('响应里没有任何 secret 字段', !JSON.stringify(payload).toLowerCase().includes('secret'))

  // 一键授权走的是公开演示应用。即便调用方是旧版 Client、塞来本机回调，也必须回 oob：
  // 演示应用只登记了 oob，其它地址会得到 redirect_uri_mismatch（2026-10-15 线上事故）。
  const sessionPath = '/dsh-history-plugin/api/v1/oauth/session'
  const session = await call('POST', sessionPath, {
    body: { redirectUri: 'http://127.0.0.1:19387/dsh-history-plugin/api/v1/oauth/redirect' },
  })
  const sessionPayload = session.json()
  check('一键授权能开会话', session.status === 200 && typeof sessionPayload?.authorizeUrl === 'string', `${session.status} ${session.payload}`)
  check('演示应用一键授权强制 redirect_uri=oob', String(sessionPayload?.authorizeUrl).includes('redirect_uri=oob'), String(sessionPayload?.authorizeUrl))
  check('一键授权不再把本机回调交给百度', !String(sessionPayload?.authorizeUrl).includes('127.0.0.1'), String(sessionPayload?.authorizeUrl))
  check('会话里记录的也是 oob', sessionPayload?.redirectUri === 'oob', String(sessionPayload?.redirectUri))
  check('一键授权响应里没有 token/secret', !/secret|access_token/i.test(session.payload), session.payload.slice(0, 160))

  const missing = await call('POST', authorizePath, { body: { appKey: '', redirectUri: 'https://example.com/cb' } })
  check('缺 AppKey 时报可读错误', missing.status === 500 && String(missing.json()?.error).includes('AppKey'), `${missing.status} ${missing.payload}`)

  // 缺凭据/缺码时 exchangeCode 会在**发请求之前**拒绝，所以这个套件仍然完全离线。
  const noKeys = await call('POST', callbackPath, { body: { appKey: '', secretKey: '', code: 'x', redirectUri: 'https://example.com/cb' } })
  check('缺应用凭据时不发请求就报错', noKeys.status === 500 && String(noKeys.json()?.error).includes('AppKey'), `${noKeys.status} ${noKeys.payload}`)

  const noCode = await call('POST', callbackPath, { body: { appKey: 'k', secretKey: 's', code: '', redirectUri: 'https://example.com/cb' } })
  check('缺授权码时不发请求就报错', noCode.status === 500 && String(noCode.json()?.error).includes('授权码'), `${noCode.status} ${noCode.payload}`)

  const ECHO = 'sekret-must-not-echo'
  const crossSite = await call('POST', callbackPath, {
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: { appKey: 'k', secretKey: ECHO, code: 'x', redirectUri: 'https://example.com/cb' },
  })
  check('提交密钥的接口受同源保护', crossSite.status === 403, String(crossSite.status))
  check('被拒时响应里不回显密钥', !crossSite.payload.includes(ECHO), crossSite.payload)

  // 这一步凭据存储是空的（上面刚删过记录），所以「测试读写」必须在**发请求之前**
  // 就如实报未授权——这个套件因此仍然完全离线。
  check('测试读写：凭据记录为空（前置条件）', records.size === 0, [...records.keys()].join(','))
  const storageTest = await call('POST', '/dsh-history-plugin/api/v1/storage-test', { body: {} })
  check('测试读写：未授权时如实报未授权', storageTest.status === 200
    && storageTest.json()?.ok === false
    && storageTest.json()?.reason === 'unconfigured', `${storageTest.status} ${storageTest.payload}`)
  check('测试读写：未授权响应里没有 token', !storageTest.payload.match(/access_token|Bearer/i), storageTest.payload)
}

/* ------------------------------------------------------------ 采集与合并 */
section('采集与跨设备历史')
{
  const body = await waitForHistory()
  check('采集器跑出了历史', body !== null, '等待超时')
  const names = (body?.rows ?? []).map(row => row.packageName).sort()
  check('记录到三个第三方插件', names.join(',') === 'dsh-image-gen,dsh-local-kit,dsh-pocket', names.join(','))
  check('不记录插件自己', !names.includes('dsh-history-plugin'))
  check('不记录官方预装', !names.includes('@deepseek-ai/dsh-base'))

  const localKit = (body?.rows ?? []).find(row => row.packageName === 'dsh-local-kit')
  check('link 安装标记为不可重装', localKit?.reinstallable === false && localKit?.installSpec === null, `${localKit?.reinstallable}/${localKit?.installSpec}`)
  const pocket = (body?.rows ?? []).find(row => row.packageName === 'dsh-pocket')
  check('registry 安装可重装', pocket?.reinstallable === true, String(pocket?.installSpec))
  check('行里带本机设备', (pocket?.devices ?? []).length === 1)
  check('设备列表包含本机', (body?.devices ?? []).length === 1)
  check('未同步时 synced=false', body?.synced === false, String(body?.synced))

  const devicePath = '/dsh-history-plugin/api/v1/device'
  const named = await call('POST', devicePath, { body: { label: '工作站' } })
  check('改设备名成功', named.status === 200 && named.json()?.device?.deviceLabel === '工作站', named.payload)
  const after = await waitForHistory()
  check('设备名进到合并视图的设备列表', (after?.devices ?? [])[0]?.label === '工作站', JSON.stringify(after?.devices))
}

/* -------------------------------------------------------------- 批量重装 */
section('批量重装')
{
  const reinstallPath = '/dsh-history-plugin/api/v1/reinstall'

  installs.length = 0
  const planned = await call('POST', reinstallPath, { body: { packages: ['dsh-pocket', 'dsh-local-kit'], dryRun: true } })
  check('预检返回 200', planned.status === 200, planned.payload)
  const plan = planned.json()?.planned ?? []
  check('预检覆盖两个包', plan.length === 2, JSON.stringify(plan))
  check('可重装的预检为 ready', plan.find(item => item.packageName === 'dsh-pocket')?.status === 'ready', JSON.stringify(plan))
  check('link 安装的预检就报不可重装', plan.find(item => item.packageName === 'dsh-local-kit')?.status === 'refused', JSON.stringify(plan))
  check('预检不真的安装', installs.length === 0, String(installs.length))

  const skipped = await call('POST', reinstallPath, { body: { packages: ['dsh-pocket'] } })
  check('本机已装的默认跳过', skipped.json()?.skipped === 1 && skipped.json()?.installed === 0, skipped.payload)
  check('跳过时没有调用安装', installs.length === 0, String(installs.length))

  const installed = await call('POST', reinstallPath, { body: { packages: ['dsh-pocket'], skipPresent: false } })
  const result = installed.json()
  check('真装时调用了 installBundle', installs.length === 1 && installs[0].spec === 'dsh-pocket@2.10.6', JSON.stringify(installs))
  check('调用方自己生成 requestId 并传入', typeof installs[0]?.requestId === 'string' && installs[0].requestId.startsWith('history-plugin-'), String(installs[0]?.requestId))
  check('结果为装好 1 个', result?.installed === 1, installed.payload)
  check('restart-required 被如实上报', result?.needsRestart === 1, installed.payload)
  check('逐条结果里标明需要重启', (result?.results ?? [])[0]?.needsRestart === true, JSON.stringify(result?.results))

  const unknown = await call('POST', reinstallPath, { body: { packages: ['根本没有这个包'] } })
  check('历史里没有的名字被单独列出', (unknown.json()?.unknown ?? [])[0] === '根本没有这个包', unknown.payload)

  const noNames = await call('POST', reinstallPath, { body: { packages: [] } })
  check('不指定包名时报错', noNames.status === 500, `${noNames.status} ${noNames.payload}`)
}

/* ------------------------------------------------------------------ 同步 */
section('同步（未授权时如实降级）')
{
  const synced = await call('POST', '/dsh-history-plugin/api/v1/sync', { body: {} })
  check('未授权时同步返回 200 但明确未完成', synced.status === 200, `${synced.status} ${synced.payload}`)
  const result = synced.json()
  check('拉取报 unconfigured', result?.pulled?.ok === false && result?.pulled?.reason === 'unconfigured', JSON.stringify(result?.pulled))
  check('推送报 unconfigured', result?.pushed?.ok === false && result?.pushed?.reason === 'unconfigured', JSON.stringify(result?.pushed))
  check('本机历史照常可用', (await waitForHistory()) !== null)
}

/* ------------------------------------------------------------------ 收尾 */
for (const dispose of effects) {
  if (typeof dispose === 'function') {
    try {
      dispose()
    } catch {
      /* 忽略 */
    }
  }
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
