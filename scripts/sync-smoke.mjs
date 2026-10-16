/**
 * 同步层回归测试：多设备合并、远端不可信输入、换账号隔离、防抖与截断。
 *
 * 全部离线：用一个内存「网盘」替身顶替传输层，不碰真实网盘。
 * 真实链路验收见 scripts/baidu-live.mjs。
 *
 * 用法：node scripts/sync-smoke.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-history-sync-'))
process.env.DSH_HOME = sandbox

const store = await import('../lib/store.js')
const sync = await import('../lib/sync.js')

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

/* ------------------------------------------------------------ 测试替身 */

/**
 * 内存网盘替身。只实现同步器用到的那几个方法。
 *
 * 关键：**按账号分盘**。真实世界里换一个百度账号就是换一个盘，文件不会跟着走；
 * 如果替身只有一个共享的 store，换账号隔离就测不出真问题。
 * @param {{ uk?: string }} [options] 初始账号。
 */
function makeCloud(options = {}) {
  const accounts = new Map()
  const writes = []
  let uk = options.uk ?? 'uk-alpha'
  const storeFor = key => {
    if (!accounts.has(key)) accounts.set(key, new Map())
    return accounts.get(key)
  }
  storeFor(uk)
  const transportFactory = () => ({
    async getAccount() {
      return { uk, baiduName: 'tester', netdiskName: 'tester', vipType: 0 }
    },
    async ensureDirs() {
      return '/dsh-history-plugin/v1/replicas'
    },
    async listReplicas() {
      return [...storeFor(uk).entries()].map(([name, buffer], index) => ({
        name, fsId: index + 1, size: buffer.length, mtime: index + 1, isDir: false, md5: null,
      }))
    },
    async readReplica(name) {
      return storeFor(uk).get(name) ?? null
    },
    async writeReplica(name, buffer) {
      writes.push({ uk, name })
      storeFor(uk).set(name, buffer)
      return { fsId: 1, size: buffer.length, replaced: true }
    },
    async deleteReplica(name) {
      return { removed: storeFor(uk).delete(name) }
    },
    async writeLocation() {},
    async readLocation() {
      return null
    },
    async listRoot() {
      return []
    },
  })
  return { accounts, storeFor, writes, transportFactory, setUk: value => { uk = value }, getUk: () => uk }
}

/** 造一份合法的远端文档。 */
function makeDocument(deviceId, label, entries) {
  return { schemaVersion: 1, deviceId, deviceLabel: label, updatedAt: '2026-09-01T00:00:00.000Z', entries }
}

const entryFor = (deviceId, packageName, version, at) => store.buildEntry(
  {
    packageName,
    version,
    installSpec: `${packageName}@${version}`,
    kind: store.KIND_INSTALLED,
    at,
    provenance: store.PROVENANCE.marketLog,
  },
  deviceId,
)

/* -------------------------------------------------------------- 合并逻辑 */
section('跨设备合并')
{
  const localDevice = store.loadDevice().deviceId
  const local = makeDocument(localDevice, '本机', [
    entryFor(localDevice, 'dsh-image-gen', '0.8.6', '2026-10-10T08:57:47.632Z'),
    entryFor(localDevice, 'dsh-brand', '1.0.0', '2026-10-12T06:33:58.647Z'),
  ])
  const other = makeDocument('device-bbbb', '另一台电脑', [
    // 同一个包、同一个版本 → 必须合并成一行，只是设备数变成 2。
    entryFor('device-bbbb', 'dsh-image-gen', '0.8.6', '2026-10-11T03:00:00.000Z'),
    // 只在另一台机器上有 → 本机 missing，这正是「一键装回」要用的信息。
    entryFor('device-bbbb', 'dsh-pocket', '2.10.6', '2026-10-09T01:00:00.000Z'),
  ])

  const current = new Map([['dsh-image-gen', '0.8.6'], ['dsh-brand', '1.0.0']])
  const merged = sync.mergeDocuments([local, other], current)
  check('两个设备合并为 3 行', merged.rows.length === 3, `得到 ${merged.rows.length}`)
  check('同插件跨设备合并为一行', merged.rows.find(row => row.packageName === 'dsh-image-gen')?.deviceCount === 2)
  const imageGen = merged.rows.find(row => row.packageName === 'dsh-image-gen')
  check('合并行的条目包含两台设备', imageGen?.entryCount === 2, String(imageGen?.entryCount))
  const pocket = merged.rows.find(row => row.packageName === 'dsh-pocket')
  check('别的设备独有 → 标为本机缺失', pocket?.present === false, String(pocket?.present))
  check('本机已有 → 不标缺失', imageGen?.present === true)
  check('本机版本被带出', pocket?.presentVersion === null && imageGen?.presentVersion === '0.8.6')
  check('设备列表含两个设备名', merged.devices.length === 2 && merged.devices.some(d => d.label === '另一台电脑'))
  check('按最新时间排序', merged.rows[0].packageName === 'dsh-brand', merged.rows.map(r => r.packageName).join(','))
  check('可重装目标取最新 spec', imageGen?.installSpec === 'dsh-image-gen@0.8.6', String(imageGen?.installSpec))

  // link 安装的包不可重装：必须体现为一个「没有重装目标」的行。
  const localOnly = makeDocument(localDevice, '本机', [
    store.buildEntry(
      { packageName: 'dsh-workbench-kit', version: '0.1.0', source: store.normalizeSource({ packageName: 'dsh-workbench-kit', version: '0.1.0', installSpec: 'link:C:/x' }), kind: store.KIND_DISCOVERED, at: '2026-10-13T00:00:00.000Z', provenance: store.PROVENANCE.profileScan, eventId: store.scanEventId({ deviceId: localDevice, packageName: 'dsh-workbench-kit', version: '0.1.0' }) },
      localDevice,
    ),
  ])
  const localMerged = sync.mergeDocuments([localOnly], new Map())
  const kit = localMerged.rows[0]
  check('link 安装的行没有重装目标', kit.reinstallable === false && kit.installSpec === null, `${kit.reinstallable}/${kit.installSpec}`)
  check('link 安装的来源类型保留', kit.sourceType === 'local', String(kit.sourceType))
}

/* ---------------------------------------------------------------- 截断 */
section('超出上限时按最新保留并如实记录')
{
  const deviceId = store.loadDevice().deviceId
  const entries = []
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  for (let index = 0; index < 6000; index += 1) {
    entries.push({
      eventId: `evt-${String(index).padStart(8, '0')}`,
      kind: 'installed',
      key: `registry:pkg-${index}@1.0.0`,
      packageName: `pkg-${index}`,
      version: '1.0.0',
      installSpec: `pkg-${index}@1.0.0`,
      sourceType: 'registry',
      reinstallable: true,
      installedAt: new Date(base + index * 60_000).toISOString(),
      deviceId,
      provenance: 'market-log',
    })
  }
  const document = makeDocument(deviceId, '本机', entries)
  const raw = Buffer.byteLength(JSON.stringify(document), 'utf8')
  check('构造的文档确实超过 1 MiB', raw > sync.MAX_DOCUMENT_BYTES, `${raw} 字节`)

  const trimmed = sync.trimToFit(document)
  check('裁剪后不超过上限', trimmed.bytes <= sync.MAX_DOCUMENT_BYTES, `${trimmed.bytes} 字节`)
  check('确实裁掉了条目', trimmed.dropped > 0, `裁掉 ${trimmed.dropped}`)
  check('如实记录截断条数', trimmed.document.truncated?.dropped === trimmed.dropped, JSON.stringify(trimmed.document.truncated))
  const keptTimes = trimmed.document.entries.map(entry => entry.installedAt)
  check('保留的是最新的那些', keptTimes[0] === entries[entries.length - 1].installedAt, String(keptTimes[0]))
  check('最旧的已被裁掉', !keptTimes.includes(entries[0].installedAt))
  check('保留的条目按时间降序', keptTimes.every((time, index) => index === 0 || keptTimes[index - 1] >= time))

  // 不超限时必须原样返回，不许多写 truncated 字段。
  const small = sync.trimToFit(makeDocument(deviceId, '本机', [entryFor(deviceId, 'a-plugin', '1.0.0', '2026-10-13T00:00:00.000Z')]))
  check('未超限时不截断', small.dropped === 0 && small.document.truncated === undefined)
}

/* ------------------------------------------------------------ 同步编排 */
section('同步编排（未配置）')
{
  const cloud = makeCloud()
  const engine = sync.createSync({
    getGrant: async () => null,
    getDevice: () => store.loadDevice(),
    getCurrent: () => new Map(),
    config: { remoteDir: '/dsh-history-plugin', autoSync: false },
    transportFactory: cloud.transportFactory,
  })
  const pulled = await engine.pull()
  const pushed = await engine.push()
  check('未授权时拉取返回 unconfigured', pulled.ok === false && pulled.reason === 'unconfigured', JSON.stringify(pulled))
  check('未授权时推送返回 unconfigured', pushed.ok === false && pushed.reason === 'unconfigured', JSON.stringify(pushed))
  check('未授权时状态标记为未配置', engine.status().configured === false)
  engine.dispose()
}

section('同步编排（推送 / 拉取 / 坏文件 / 换账号）')
{
  // 本机账本先放两条，其中一条与另一台设备同包同版本。
  const localDevice = store.loadDevice().deviceId
  store.appendEntries([
    store.buildEntry(
      {
        packageName: 'dsh-image-gen', version: '0.8.6', installSpec: 'dsh-image-gen@0.8.6',
        kind: store.KIND_INSTALLED, at: '2026-10-10T08:57:47.632Z', provenance: store.PROVENANCE.marketLog,
        eventId: store.marketEventId({ deviceId: localDevice, packageName: 'dsh-image-gen', key: 'registry:dsh-image-gen@0.8.6', installedAt: '2026-10-10T08:57:47.632Z' }),
      },
      localDevice,
    ),
  ])

  const cloud = makeCloud()
  const warnings = []
  const engine = sync.createSync({
    getGrant: async () => ({ grant: { accessToken: 'fake-token' }, source: 'credentials' }),
    getDevice: () => store.loadDevice(),
    getCurrent: () => new Map([['dsh-image-gen', '0.8.6']]),
    config: { remoteDir: '/dsh-history-plugin', autoSync: false },
    transportFactory: cloud.transportFactory,
    onWarn: message => warnings.push(message),
  })

  const pushed = await engine.push()
  check('推送成功', pushed.ok === true, JSON.stringify(pushed))
  check('推送写的是本机设备文件', cloud.writes[0]?.name === `${localDevice}.json`, String(cloud.writes[0]?.name))
  const disks = cloud.storeFor('uk-alpha')
  const stored = JSON.parse(disks.get(`${localDevice}.json`).toString('utf8'))
  check('推送文档带 schemaVersion', stored.schemaVersion === 1)
  check('推送文档带的设备就是本机', stored.deviceId === localDevice)

  const pushedAgain = await engine.push()
  check('无变化时跳过推送', pushedAgain.ok === true && pushedAgain.skipped === 'unchanged', JSON.stringify(pushedAgain))
  check('跳过时没有再写网盘', cloud.writes.length === 1, cloud.writes.map(write => write.name).join(','))

  /* 往网盘里放别的设备的副本，外加两个坏文件。 */
  const other = 'device-bbbb'
  const validDoc = makeDocument(other, '另一台电脑', [
    entryFor(other, 'dsh-image-gen', '0.8.6', '2026-10-11T03:00:00.000Z'),
    entryFor(other, 'dsh-pocket', '2.10.6', '2026-10-09T01:00:00.000Z'),
  ])
  disks.set(`${other}.json`, Buffer.from(JSON.stringify(validDoc), 'utf8'))
  disks.set('device-cccc.json', Buffer.from(JSON.stringify({ schemaVersion: 99, deviceId: 'device-cccc', entries: [] }), 'utf8'))
  disks.set('device-dddd.json', Buffer.from(JSON.stringify(validDoc), 'utf8')) // 文件名与内部设备不符
  disks.set('readme.txt', Buffer.from('not a replica', 'utf8'))

  const pulled = await engine.pull()
  check('拉取成功', pulled.ok === true, JSON.stringify(pulled).slice(0, 200))
  check('合并出两个设备', pulled.devices.length === 2, pulled.devices.map(d => d.deviceId).join(','))
  check('跨设备同插件合并为一行', pulled.rows.find(row => row.packageName === 'dsh-image-gen')?.deviceCount === 2)
  check('别的设备独有的插件出现在结果里', pulled.rows.some(row => row.packageName === 'dsh-pocket'))
  const reasons = (pulled.skipped ?? []).map(item => item.reason).sort()
  check('坏 schema 的文件被跳过', reasons.includes('invalid-schema'), JSON.stringify(reasons))
  check('设备与文件名不符的被跳过', reasons.includes('device-mismatch'), JSON.stringify(reasons))
  check('非副本文件不被当作设备', !pulled.devices.some(device => device.deviceId === 'readme'))
  check('跳过的文件有告警', warnings.some(message => message.includes('被跳过')), warnings.join(' | '))
  check('状态里能看到两台设备', engine.status().deviceCount === 2)
  check('状态里不含任何 token', !JSON.stringify(engine.status()).includes('fake-token'))

  /* 换网盘账号：换账号就是换一个盘，上一个账号的远端视图必须整体消失。 */
  cloud.setUk('uk-beta')
  const afterSwitch = await engine.pull()
  check('换账号后仍能拉取', afterSwitch.ok === true)
  check('换账号后看不到上一个账号的设备', !afterSwitch.devices.some(device => device.deviceId === other), afterSwitch.devices.map(d => d.deviceId).join(','))
  check('换账号后只剩本机一个设备', afterSwitch.devices.length === 1 && afterSwitch.devices[0].deviceId === localDevice, afterSwitch.devices.map(d => d.deviceId).join(','))
  check('换账号后行里不再有别的账号的插件', !afterSwitch.rows.some(row => row.packageName === 'dsh-pocket'), afterSwitch.rows.map(r => r.packageName).join(','))
  check('新账号的盘里没有上一个账号的副本', !cloud.storeFor('uk-beta').has(`${other}.json`))
  check('状态里的账号已更新', engine.status().accountUk === 'uk-beta', String(engine.status().accountUk))
  check('远端缓存按账号分目录存放', existsSync(join(sandbox, 'history-plugin', 'accounts', 'uk-alpha', 'remote.json')) && existsSync(join(sandbox, 'history-plugin', 'accounts', 'uk-beta', 'remote.json')))

  const betaPush = await engine.push()
  check('换账号后推送写到新账号的盘', betaPush.ok === true && cloud.storeFor('uk-beta').has(`${localDevice}.json`), JSON.stringify(betaPush))

  engine.dispose()
  const afterDispose = await engine.pull()
  check('dispose 后不再同步', afterDispose.ok === false && afterDispose.reason === 'disposed', JSON.stringify(afterDispose))
}

section('状态与待推送判断')
{
  const cloud = makeCloud()
  const engine = sync.createSync({
    getGrant: async () => ({ grant: { accessToken: 'fake-token' }, source: 'credentials' }),
    getDevice: () => store.loadDevice(),
    getCurrent: () => new Map(),
    config: { remoteDir: '/dsh-history-plugin', autoSync: false },
    transportFactory: cloud.transportFactory,
  })
  await engine.push()
  check('推送后没有待推送变化', engine.hasPendingChanges() === false)
  // 往账本里追加一条，应当立刻体现为「有变化」。
  const deviceId = store.loadDevice().deviceId
  store.appendEntries([
    store.buildEntry({ packageName: 'new-plugin', version: '1.0.0', installSpec: 'new-plugin@1.0.0', provenance: store.PROVENANCE.installResult }, deviceId),
  ])
  check('新增事件后有待推送变化', engine.hasPendingChanges() === true)
  const pushed = await engine.push()
  check('推送新变化成功', pushed.ok === true && pushed.entries >= 2, JSON.stringify(pushed))
  check('推送后再次归零', engine.hasPendingChanges() === false)
  engine.dispose()
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
