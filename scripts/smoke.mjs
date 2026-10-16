/**
 * 阶段 1 冒烟测试：不启动 DSH，直接跑核心服务。
 *
 * 覆盖三块最容易出错的地方：
 *   1) 来源归一化（同一个仓库的四种写法必须得到同一个 key）
 *   2) 事件校验（远端 JSON 是不可信输入：超长 / 穿越 / 凭据 / 未知 schema 全拒）
 *   3) 采集过滤与市场日志补录（对着本机真实的 profile 与市场日志跑一遍，只读）
 *
 * 刻意把 `DSH_HOME` 指向临时目录：测试绝不能污染真实账本。
 * 需要真实 profile 数据时通过 `DSH_PROFILE_DIR` 只读读取。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-history-smoke-'))
process.env.DSH_HOME = sandbox

const store = await import('../lib/store.js')
const collector = await import('../lib/collector.js')
const { loadDevice, setDeviceLabel, validateEntry, validateRemoteDocument, normalizeSource, parseGitSpec, buildEntry, appendEntries, loadHistory, aggregateByPackage, buildUploadDocument, redactUrl, isLocalSpec, marketEventId, PROVENANCE, KIND_DISCOVERED, KIND_INSTALLED } = store
const { isRecordableBundle, currentRecordable, sourceOf, parseMarketLog, marketEntries, createCollector } = collector

let failed = 0
let passed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function section(title) {
  console.log(`\n== ${title} ==`)
}

/* ------------------------------------------------------------ 设备身份 */
section('设备身份')
const device = loadDevice()
check('首次调用生成 UUID', /^[A-Za-z0-9-]{36}$/.test(device.deviceId), device.deviceId)
check('默认无显示名', device.deviceLabel === null)
const again = loadDevice()
check('重复调用复用同一设备 ID', again.deviceId === device.deviceId)
check('可设置显示名', setDeviceLabel('我的笔记本').deviceLabel === '我的笔记本')
check('显示名可清除', setDeviceLabel('   ').deviceLabel === null)

/* --------------------------------------------------------- 来源归一化 */
section('来源归一化')
const cases = [
  ['registry 范围', { packageName: 'dsh-industry-research', version: '0.3.19' }, 'registry:dsh-industry-research@0.3.19', 'registry', true],
  ['registry scoped', { packageName: '@xmanrui/dsh-im', version: '4.38.0', installSpec: '@xmanrui/dsh-im@4.38.0' }, 'registry:@xmanrui/dsh-im@4.38.0', 'registry', true],
  ['github 简写', { packageName: 'dsh-brand', version: '0.0.0', installSpec: 'github:advance-lion/dsh-brand#7b83f7387b99ae6173b67867d4a3b915c7942d02' }, 'git:github.com/advance-lion/dsh-brand#7b83f7387b99ae6173b67867d4a3b915c7942d02', 'git', true],
]
for (const [label, input, expectedKey, expectedType, expectedReinstallable] of cases) {
  const got = normalizeSource(input)
  check(`${label} → key`, got.key === expectedKey, got.key)
  check(`${label} → sourceType`, got.sourceType === expectedType, got.sourceType)
  check(`${label} → reinstallable`, got.reinstallable === expectedReinstallable, String(got.reinstallable))
}

// 同一个仓库的四种写法必须归一到同一个 key —— 这是跨设备匹配的成立前提。
const variants = [
  'github:advance-lion/dsh-brand#abc123',
  'git+https://github.com/advance-lion/dsh-brand.git#abc123',
  'https://github.com/advance-lion/dsh-brand#abc123',
  'advance-lion/dsh-brand#abc123',
]
const keys = variants.map(spec => normalizeSource({ packageName: 'dsh-brand', version: '1.0.0', installSpec: spec }).key)
check('四种 git 写法同一 key', new Set(keys).size === 1, keys.join(' | '))

const withToken = normalizeSource({ packageName: 'x', version: '1.0.0', installSpec: 'git+https://user:ghp_secret@github.com/acme/private-repo.git#main' })
check('git 地址剥离用户信息', withToken.key === 'git:github.com/acme/private-repo#main', withToken.key)
check('git 地址不含凭据', !withToken.installSpec.includes('ghp_secret'), withToken.installSpec)

const localLink = normalizeSource({ packageName: 'dsh-workbench-kit', version: '0.1.0', installSpec: 'link:C:/Users/ORiSUNG/Documents/投研工作台/plugins/dsh-workbench-kit' })
check('link 来源标记不可重装', localLink.reinstallable === false)
check('link 来源不把路径写进 key', !localLink.key.includes('投研'), localLink.key)
check('link 来源不产出 installSpec', localLink.installSpec === null)
check('link 识别', isLocalSpec('link:C:/x') && isLocalSpec('file:./y') && isLocalSpec('C:\\z') && !isLocalSpec('dsh-image-gen'))

const tarball = normalizeSource({ packageName: 'dshmarket', version: '1.66.14', installSpec: 'https://codeload.github.com/dsh-market/dsh-market/tar.gz/fd6e?access_token=SECRET' })
check('tarball 丢弃查询串', !tarball.key.includes('SECRET') && !tarball.key.includes('?'), tarball.key)

// 畸形 URL：解析不了就绝不能掉进 registry 分支、把原始串当包名存下来——
// 那样一个夹带凭据的畸形 URL 就有机会进云文件。这里先证明构造的串真的解析不了。
const malformed = 'https://bad host/x?token=SECRET'
check('构造的 URL 确实解析不了（前置条件）', redactUrl(malformed) === null, String(redactUrl(malformed)))
const malformedSource = normalizeSource({ packageName: 'weird', version: '1.0.0', installSpec: malformed })
check('畸形 URL 不保留 installSpec', malformedSource.installSpec === null, String(malformedSource.installSpec))
check('畸形 URL 的 key 里没有凭据也没有主机', !malformedSource.key.includes('SECRET') && !malformedSource.key.includes('bad host'), malformedSource.key)
check('畸形 URL 标成 url 且不可重装', malformedSource.sourceType === 'url' && malformedSource.reinstallable === false, malformedSource.sourceType)
check('畸形 URL 类型能通过事件校验（不会静默丢事件）', validateEntry({
  eventId: '0123456789abcdef0123456789abcdef01234567',
  kind: KIND_INSTALLED,
  key: malformedSource.key,
  packageName: 'weird',
  version: '1.0.0',
  installSpec: malformedSource.installSpec,
  sourceType: malformedSource.sourceType,
  reinstallable: malformedSource.reinstallable,
  installedAt: '2026-10-13T00:00:00.000Z',
  deviceId: 'device-1',
  provenance: PROVENANCE.installResult,
}, 'device-1') !== null)

/* --------------------------------------------------------- 配置收敛（目录） */
section('配置收敛：云端目录按不可信输入处理')
{
  const { normalizeConfig, DEFAULT_CONFIG } = await import('../lib/index.js')
  check('合法目录沿用', normalizeConfig({ remoteDir: '/我的应用数据/插件历史' }).remoteDir === '/我的应用数据/插件历史')
  check('去掉尾部斜杠', normalizeConfig({ remoteDir: '/a/b///' }).remoteDir === '/a/b')
  check('相对路径退回默认', normalizeConfig({ remoteDir: 'relative/dir' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('空值退回默认', normalizeConfig({ remoteDir: '   ' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('保留目录退回默认（它是内部结构）', normalizeConfig({ remoteDir: '/dsh-history-plugin/v1' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  // 路径穿越：`..` 与 `.` 段必须被拒，否则用户一个笔误就能写到别处。
  check('拒绝 .. 穿越', normalizeConfig({ remoteDir: '/a/../../etc' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('拒绝单独一段 ..', normalizeConfig({ remoteDir: '/..' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('拒绝 . 段', normalizeConfig({ remoteDir: '/a/./b' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('拒绝 NUL 字符', normalizeConfig({ remoteDir: '/a\u0000b' }).remoteDir === DEFAULT_CONFIG.remoteDir)
  check('拒绝超长目录', normalizeConfig({ remoteDir: `/${'x'.repeat(600)}` }).remoteDir === DEFAULT_CONFIG.remoteDir)
  const other = normalizeConfig({ remoteDir: '/../x', autoSync: false, pullOnStart: false })
  check('非法目录不影响其它配置项', other.remoteDir === DEFAULT_CONFIG.remoteDir && other.autoSync === false && other.pullOnStart === false,
    JSON.stringify(other))
  check('配置整体不是对象也不崩', normalizeConfig(null).remoteDir === DEFAULT_CONFIG.remoteDir)
}
check('redactUrl 只留 host/path', redactUrl('https://u:p@h.com/a/b?token=x#f') === 'h.com/a/b', redactUrl('https://u:p@h.com/a/b?token=x#f'))
check('parseGitSpec 无主机返回 null', parseGitSpec('dsh-image-gen') === null)

/* ------------------------------------------------------------ 事件校验 */
section('事件校验')
const good = buildEntry({ packageName: 'dsh-image-gen', version: '0.8.6', installSpec: 'dsh-image-gen@0.8.6', provenance: PROVENANCE.installResult }, device.deviceId)
check('正常事件通过校验', good !== null && good.kind === KIND_INSTALLED && good.eventId.length === 36)

const rejections = [
  ['事件 ID 过短', { ...good, eventId: 'x' }],
  ['未知 kind', { ...good, kind: 'upgraded' }],
  ['路径穿越 key', { ...good, key: 'registry:../../etc/passwd@1' }],
  ['超长 installSpec', { ...good, installSpec: 'a'.repeat(400) }],
  ['未知 sourceType', { ...good, sourceType: 'ftp' }],
  ['未知 provenance', { ...good, provenance: 'guessed' }],
  ['installed 缺安装时间', { ...good, installedAt: undefined }],
  ['时间戳非法', { ...good, installedAt: 'yesterday' }],
  ['设备 ID 非法', { ...good, deviceId: 'nope' }],
  ['spec 夹带 token', { ...good, installSpec: 'https://h/x.tgz?sign=abcdef' }],
]
for (const [label, raw] of rejections) {
  check(`拒收：${label}`, validateEntry(raw) === null)
}
const discovered = buildEntry({ packageName: 'dsh-pocket', version: '2.10.6', kind: KIND_DISCOVERED, provenance: PROVENANCE.profileScan }, device.deviceId)
check('discovered 只带 observedAt', discovered !== null && discovered.observedAt !== undefined && discovered.installedAt === undefined)

section('远端文档校验')
const upload = buildUploadDocument('我的笔记本')
check('上传文档自称 schemaVersion=1', upload.schemaVersion === 1)
check('上传文档可被自己校验通过', validateRemoteDocument(upload) !== null)
check('拒收未知 schema', validateRemoteDocument({ ...upload, schemaVersion: 2 }) === null)
check('拒收顶层数组', validateRemoteDocument([]) === null)
check('拒收 entries 非数组', validateRemoteDocument({ ...upload, entries: 'x' }) === null)
check('拒收事件设备与文件不符', validateRemoteDocument({ ...upload, entries: [{ ...upload.entries[0], deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] }) === null)
check('拒收伪造修改的条目', validateRemoteDocument({ ...upload, entries: [{ ...upload.entries[0], installSpec: 'a'.repeat(400) }] }) === null)

/* ---------------------------------------------------- 采集过滤（对照本机） */
section('采集过滤规则')
const fixtures = [
  [{ name: 'dsh-image-gen', installed: true, removable: true, enabled: true }, true, '第三方已装'],
  [{ name: '@deepseek-ai/dsh-web-app', installed: true, removable: false, enabled: true }, false, '官方预装'],
  [{ name: 'dsh-better-sidebar', installed: false, removable: false, enabled: true }, false, '仅启用的官方项'],
  [{ name: 'dsh-history-plugin', installed: true, removable: true, enabled: true }, false, '插件自己'],
  [{ name: 'dsh-pocket', installed: true, removable: true, enabled: true, version: '2.10.6' }, true, '普通第三方'],
]
for (const [bundle, expected, label] of fixtures) {
  check(`过滤：${label}`, isRecordableBundle(bundle) === expected)
}

section('spec 合成')
check('范围依赖用确切版本', sourceOf('dsh-industry-research', '^0.3.19', '0.3.19').key === 'registry:dsh-industry-research@0.3.19')
check('git 依赖保留 ref', sourceOf('dsh-brand', 'github:advance-lion/dsh-brand#7b83f7', '1.0.0').key === 'git:github.com/advance-lion/dsh-brand#7b83f7')
check('link 依赖不可重装', sourceOf('dsh-workbench-kit', 'link:C:/x', '0.1.0').reinstallable === false)

/* --------------------------------------------- 真实 profile 只读冒烟 */
section('真实 profile（只读）')
const profileDir = process.env.DSH_PROFILE_DIR ?? null
if (profileDir === null) {
  console.log('  skip 未设置 DSH_PROFILE_DIR，跳过真实数据核对')
} else {
  const records = parseMarketLog(profileDir)
  check('市场日志解析出成功安装', records.length >= 5, `得到 ${records.length} 条`)
  const registryRecords = records.filter(r => /^[^@/]|^@[^/]+\//.test(r.name) && r.version !== null)
  check('市场日志里带确切版本的记录存在', registryRecords.length >= 4, `得到 ${registryRecords.length} 条`)
  const dates = records.map(r => r.at)
  check('市场日志时间戳可解析且升序', dates.every(d => Number.isFinite(Date.parse(d))) && dates.join() === [...dates].sort().join())
  // git 安装行不带版本号：身份由 commit ref 承载，版本允许为空。
  // 刻意不用 node_modules 里的当前版本回填 —— 那会把「后来升级的版本」
  // 记到「当初那次安装」头上，等于伪造历史。
  const brand = records.find(r => r.spec.startsWith('github:'))
  check('市场日志能识别 git 安装', brand !== undefined, brand === undefined ? 'none' : JSON.stringify(brand))
  check('git 记录的版本允许为空', brand !== undefined && (brand.version === null || typeof brand.version === 'string'))
  const brandEntry = marketEntries(profileDir, device.deviceId).find(e => e.packageName === 'dsh-brand')
  check('git 事件保留 commit ref', brandEntry !== undefined && /^git:github\.com\/advance-lion\/dsh-brand#[0-9a-f]{40}$/.test(brandEntry.key), brandEntry === undefined ? 'none' : brandEntry.key)
  check('git 事件可重装', brandEntry !== undefined && brandEntry.reinstallable === true && /^github:advance-lion\/dsh-brand#[0-9a-f]{40}$/.test(brandEntry.installSpec), brandEntry === undefined ? 'none' : String(brandEntry.installSpec))
  const entries = marketEntries(profileDir, device.deviceId)
  check('市场日志可转成合法事件', entries.length === records.length && entries.every(e => e !== null), `${entries.length}/${records.length}`)
  check('市场事件带真实安装时间', entries.every(e => Number.isFinite(Date.parse(e.installedAt))))
  check('市场事件来源标记正确', entries.every(e => e.provenance === PROVENANCE.marketLog))

  const manifest = collector.readProfileManifest(profileDir)
  const depNames = Object.keys(manifest.dependencies)
  check('读到 profile 依赖表', depNames.length >= 8, depNames.join(', '))
  const bundles = depNames.map(name => ({ name, installed: true, removable: true, enabled: true, version: '1.0.0' }))
  const current = currentRecordable(bundles, manifest.dependencies)
  check('当前可记录集合排除本插件自身', !current.has('dsh-history-plugin'))
  check('当前可记录集合覆盖其余全部第三方依赖', current.size === depNames.length - 1, `${current.size}/${depNames.length - 1}`)
  const wb = current.get('dsh-workbench-kit')
  check('link 安装的包被标为不可重装', wb !== undefined && wb.source.reinstallable === false)
}

/* ------------------------------------------------------- 账本与聚合 */
section('账本与聚合')
const before = loadHistory().entries.length
appendEntries([good, good]) // 同一条两次
check('eventId 去重', loadHistory().entries.length === before + 1, `+${loadHistory().entries.length - before}`)
const other = buildEntry({ packageName: 'dsh-image-gen', version: '0.9.0', installSpec: 'dsh-image-gen@0.9.0', provenance: PROVENANCE.installResult, at: new Date(Date.now() + 60000).toISOString(), eventId: undefined }, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
appendEntries([other])
check('异设备事件可入库', loadHistory().entries.length === before + 2)
const rows = aggregateByPackage(loadHistory().entries)
check('按包聚合', rows.length === 1 && rows[0].packageName === 'dsh-image-gen', JSON.stringify(rows.map(r => r.packageName)))
check('聚合含两台设备', rows[0].devices.length === 2, rows[0].devices.join(','))
check('聚合按最新时间排序', rows[0].version === '0.9.0', rows[0].version)

/* ---------------------------------------------------------- 去重压缩（自愈） */
section('去重压缩（自愈旧版残留）')
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const target = { deviceId: device.deviceId, packageName: 'x-plugin', key: 'registry:x-plugin@1.0.0', installedAt: '2026-08-01T00:00:00.000Z' }
  const deterministic = marketEventId(target)
  const randomIds = ['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444']
  const marketEntry = id => ({
    eventId: id, kind: KIND_INSTALLED, key: target.key, packageName: 'x-plugin', version: '1.0.0',
    installSpec: 'x-plugin@1.0.0', sourceType: 'registry', reinstallable: true,
    installedAt: target.installedAt, deviceId: device.deviceId, provenance: PROVENANCE.marketLog,
  })
  // 模拟旧版本写坏的账本：同一市场事实 3 条（随机 + 确定性 + 随机），
  // 外加一条无身份的实时事件 —— 后者每次都是一次独立事实，绝不能被合并。
  const realtime = buildEntry({ packageName: 'x-plugin', version: '2.0.0', installSpec: 'x-plugin@2.0.0', provenance: PROVENANCE.installResult }, device.deviceId)
  const broken = {
    schemaVersion: 1, deviceId: device.deviceId, updatedAt: '2026-08-01T00:00:00.000Z',
    entries: [marketEntry(randomIds[0]), marketEntry(deterministic), marketEntry(randomIds[1]), realtime],
  }
  writeFileSync(join(sandbox, 'history-plugin', 'history.json'), JSON.stringify(broken), 'utf8')

  const compacted = loadHistory().entries
  const xMarket = compacted.filter(e => e.provenance === PROVENANCE.marketLog)
  check('压缩：同一市场事实只留一条', xMarket.length === 1, `得到 ${xMarket.length}`)
  check('压缩：保留确定性 ID 的那条', xMarket[0]?.eventId === deterministic, String(xMarket[0]?.eventId))
  check('压缩：实时事件不被合并', compacted.filter(e => e.provenance === PROVENANCE.installResult).length === 1)
  check('压缩：总数收敛到 2', compacted.length === 2, `得到 ${compacted.length}`)
  const onDisk = JSON.parse(readFileSync(join(sandbox, 'history-plugin', 'history.json'), 'utf8'))
  check('压缩：结果已自愈写回磁盘', onDisk.entries.length === 2, `得到 ${onDisk.entries.length}`)
}

/* ------------------------------------------------ 采集器集成（假 manager） */
section('采集器集成（临时 profile + 假 pluginManager）')
{
  // 这一段断言的是账本的绝对条数，所以在开始前把前面段落留下的账本清掉，
  // 否则失败原因会是「测试之间互相污染」而不是被测逻辑有问题。
  const { mkdirSync, unlinkSync, writeFileSync } = await import('node:fs')
  for (const file of ['history.json', 'state.json']) {
    try {
      unlinkSync(join(sandbox, 'history-plugin', file))
    } catch {
      /* 本来就不存在 */
    }
  }
  const fakeProfile = join(sandbox, 'profile')
  mkdirSync(join(fakeProfile, '.dsh-market'), { recursive: true })
  writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: {
      'a-plugin': '1.0.0',
      'b-plugin': 'github:acme/b-plugin#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'c-local': 'link:C:/somewhere/c-local',
    },
  }), 'utf8')
  // 市场日志：只有 a-plugin 有确证记录（带真实时间）；另一条失败记录必须被忽略。
  writeFileSync(join(fakeProfile, '.dsh-market', 'log.ndjson'), [
    JSON.stringify({ at: '2026-09-01T10:00:00.000Z', level: 'info', event: 'install', detail: 'a-plugin: pinned to the registry\'s latest, 1.0.0, so pnpm\'s fresh-release hold cannot substitute an older version silently' }),
    JSON.stringify({ at: '2026-09-01T10:00:10.000Z', level: 'info', event: 'install', detail: 'a-plugin@1.0.0 exit=0 hot=true' }),
    JSON.stringify({ at: '2026-09-01T11:00:00.000Z', level: 'error', event: 'install', detail: 'z-failed@2.0.0 exit=1 err=boom' }),
  ].join('\n') + '\n', 'utf8')

  const bundle = (name, version, extra = {}) => ({ name, version, installed: true, removable: true, enabled: true, ...extra })
  let live = [
    bundle('a-plugin', '1.0.0'),
    bundle('b-plugin', '0.0.0-git'),
    bundle('c-local', '0.1.0'),
    bundle('@deepseek-ai/dsh-base', '0.2.0', { installed: false, removable: false }),
    bundle('dsh-history-plugin', '0.1.0'),
  ]
  const plot = () => ({ listBundles: async () => live })

  const collect = createCollector({ getManager: plot, profileDir: fakeProfile })
  const first = await collect.start()
  const afterFirst = loadHistory().entries
  check('集成：只记外部 bundle（排除官方与自身）', afterFirst.length === 3, `得到 ${afterFirst.length}: ${afterFirst.map(e => e.packageName).join(',')}`)
  check('集成：失败安装不入历史', !afterFirst.some(e => e.packageName === 'z-failed'))
  const a = afterFirst.find(e => e.packageName === 'a-plugin')
  check('集成：市场日志给出确证安装时间', a !== undefined && a.kind === KIND_INSTALLED && a.installedAt === '2026-09-01T10:00:10.000Z', JSON.stringify(a?.installedAt))
  check('集成：市场事件来源为 market-log', a?.provenance === PROVENANCE.marketLog)
  const b = afterFirst.find(e => e.packageName === 'b-plugin')
  check('集成：git 依赖归一化', b !== undefined && b.sourceType === 'git' && b.key === 'git:github.com/acme/b-plugin#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', b?.key)
  const c = afterFirst.find(e => e.packageName === 'c-local')
  check('回归：local 来源透传不被降级', c !== undefined && c.sourceType === 'local', `${c?.sourceType}`)
  check('回归：local 来源 reinstallable=false', c !== undefined && c.reinstallable === false, String(c?.reinstallable))
  check('集成：无市场记录者记为首见', b?.kind === KIND_DISCOVERED && c?.kind === KIND_DISCOVERED)
  check('集成：首见只有 observedAt', b !== undefined && b.observedAt !== undefined && b.installedAt === undefined)
  check('集成：每个事件都带本机设备 ID', afterFirst.every(e => e.deviceId === device.deviceId))
  check('集成：首轮计入', first.recorded === 3, String(first.recorded))

  await collect.start()
  check('回归：重复核对幂等（市场日志不重复入库）', loadHistory().entries.length === 3, `得到 ${loadHistory().entries.length}`)

  live = live.filter(item => item.name !== 'c-local')
  await collect.start()
  check('集成：卸载不删历史', loadHistory().entries.length === 3)
  live = [...live, bundle('c-local', '0.1.0')]
  await collect.start()
  const reinstalled = loadHistory().entries.filter(e => e.packageName === 'c-local')
  check('集成：重装产生新事件', reinstalled.length === 2, `得到 ${reinstalled.length}`)
  check('集成：重装事件是 installed 且有安装时间', reinstalled.some(e => e.kind === KIND_INSTALLED && e.installedAt !== undefined))

  live = live.map(item => (item.name === 'b-plugin' ? { ...item, version: '0.0.0-git2' } : item))
  await collect.start()
  check('集成：版本变化产生新事件', loadHistory().entries.filter(e => e.packageName === 'b-plugin').length === 2)

  collect.dispose()
  await collect.start()
  check('集成：dispose 后不再采集', loadHistory().entries.filter(e => e.packageName === 'b-plugin').length === 2)
}

/* ----------------------------------------------------- 临时文件清扫 */
section('临时文件清扫（原子写的残渣）')
{
  const util = await import('../lib/util.js')
  const { sweepTempFiles, writeJsonAtomic, dataDir, dataFile } = util

  // 找一个**确定已死**的 pid：从大往小扫，process.kill 抛 ESRCH 就是死的。
  let deadPid = null
  for (let candidate = 4_000_000; candidate > 3_000_000 && deadPid === null; candidate -= 4) {
    try {
      process.kill(candidate, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') deadPid = candidate
    }
  }
  check('找到了一个已死进程的 pid 用于构造残渣', deadPid !== null, String(deadPid))

  // 造三种残渣 + 一个正常文件 + 一个同名但 pid 活着（自己）的临时文件。
  const stale = join(dataDir(), `history.json.tmp-${deadPid}`)
  const staleInAccount = join(dataDir(), 'accounts', '2269', `remote.json.tmp-${deadPid}`)
  const ownTemp = join(dataDir(), `history.json.tmp-${process.pid}`)
  const normal = dataFile('sweep-subject.json')
  const weird = join(dataDir(), 'notes.tmp-abc')
  writeJsonAtomic(stale, { leftover: true })
  writeJsonAtomic(staleInAccount, { leftover: true })
  writeJsonAtomic(ownTemp, { inFlight: true })
  writeJsonAtomic(normal, { keep: true })
  writeJsonAtomic(weird, { keep: true })

  const result = sweepTempFiles()
  check('删掉了已死进程的残渣', result.removed === 2, JSON.stringify(result))
  check('删掉的正是那两个', result.names.filter(name => name.startsWith('history.json.tmp-')).length === 1
    && result.names.filter(name => name.startsWith('remote.json.tmp-')).length === 1, result.names.join(','))
  check('残渣真的从磁盘上消失了', !existsSync(stale) && !existsSync(staleInAccount))
  check('自己正在写的临时文件没被删', existsSync(ownTemp))
  check('正常文件没被动', existsSync(normal))
  check('名字不合规的文件没被动', existsSync(weird))
  check('保留计数只数合规的临时文件（自己那个）', result.kept === 1, String(result.kept))

  const second = sweepTempFiles()
  check('再扫一遍没有可删的了（幂等）', second.removed === 0, JSON.stringify(second))

  // 原子写自身的两条路径都不该留残渣。
  writeJsonAtomic(normal, { keep: true, updated: 1 })
  check('原子写成功后不留临时文件', readdirSync(dataDir()).filter(name => /\.tmp-\d+$/.test(name)).length === 1,
    readdirSync(dataDir()).join(','))
  check('原子写内容可读回', JSON.parse(readFileSync(normal, 'utf8')).updated === 1)

  rmSync(join(dataDir(), 'accounts'), { recursive: true, force: true })
  rmSync(ownTemp, { force: true })
  rmSync(weird, { force: true })
  rmSync(normal, { force: true })
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
