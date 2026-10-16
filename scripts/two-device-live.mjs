/**
 * 两台设备的**真实网盘**端到端验收。
 *
 * 为什么要单独有它：假网盘套件（sync-smoke）验证的是编排，真实网盘套件
 * （baidu-live）验证的是传输层。两者之间那个接缝——**同步引擎写出的文档能不能
 * 被真网盘存住、再被另一台设备的引擎读回来**——只有让引擎直接对着真网盘跑才测得到。
 *
 * 做法：一个进程里准备两个独立的 `DSH_HOME`（`dataDir()` 每次调用都重算，所以切
 * 环境变量就等于换一台设备），各自有自己的 device.json 与账本，共用同一个网盘账号。
 * 于是能真实地跑出：A 推送 → B 拉取 → B 装上自己的 → A 再拉 → 两边互相看到。
 *
 * 刻意用**独立的远端目录**（默认 `/dsh-history-plugin-livetest`），收尾把它整个删掉，
 * 绝不往真实目录 `/dsh-history-plugin` 里塞测试数据。
 *
 * 用法：BAIDU_TOKEN_FILE=<含 token 的文件> node scripts/two-device-live.mjs
 * 未设置 BAIDU_TOKEN_FILE 时直接跳过（退出码 0），所以能安全地放进常规回归。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_REMOTE_DIR, createBaiduTransport, redactToken } from '../lib/baidu.js'
import { createSync } from '../lib/sync.js'
import {
  KIND_INSTALLED,
  PROVENANCE,
  appendEntries,
  buildEntry,
  loadDevice,
  loadHistory,
  setDeviceLabel,
} from '../lib/store.js'
import { readJsonFile } from '../lib/util.js'

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

const tokenFile = process.env.BAIDU_TOKEN_FILE
if (typeof tokenFile !== 'string' || tokenFile.trim() === '' || !existsSync(tokenFile)) {
  console.log('跳过：未设置 BAIDU_TOKEN_FILE（或无此文件），本轮不碰真实网盘。')
  process.exit(0)
}

/** 只用来打日志：绝不打印 token 本体。 */
const TOKEN = readFileSync(tokenFile, 'utf8').trim()
const TEST_REMOTE_DIR = process.env.BAIDU_LIVE_REMOTE_DIR ?? '/dsh-history-plugin-livetest'
const REAL_REMOTE_DIR = DEFAULT_REMOTE_DIR
const at = offset => new Date(Date.UTC(2026, 9, 13, 3, 0, offset)).toISOString()

const sandboxes = []
/** 新建一台"设备"的家目录。 */
function newHome(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-history-${tag}-`))
  sandboxes.push(dir)
  return dir
}

/**
 * 把本进程切到某台设备，并返回它的身份。
 * @param {string} home 该设备的 DSH_HOME。
 * @param {string} label 设备显示名。
 * @returns {object} 设备记录。
 */
function useDevice(home, label) {
  process.env.DSH_HOME = home
  loadDevice()
  setDeviceLabel(label)
  return loadDevice()
}

/**
 * 建一个真实的同步引擎。
 * @param {object} options 选项。
 * @returns {object} 同步引擎。
 */
function makeEngine(options = {}) {
  return createSync({
    getGrant: async () => ({ grant: { accessToken: options.token ?? TOKEN }, source: 'live-token-file' }),
    getDevice: () => loadDevice(),
    getCurrent: () => options.current ?? new Map(),
    config: { remoteDir: options.remoteDir ?? TEST_REMOTE_DIR, autoSync: false },
    onWarn: () => {},
  })
}

/** 四段测试数据：两条 registry、一条 git、一条 link。 */
function seedEntries(deviceId) {
  return [
    buildEntry({ packageName: 'dsh-live-test-alpha', version: '1.2.3', installSpec: 'dsh-live-test-alpha@1.2.3', kind: KIND_INSTALLED, provenance: PROVENANCE.installResult, at: at(0) }, deviceId),
    buildEntry({ packageName: 'dsh-live-test-beta', version: '0.4.0', installSpec: 'dsh-live-test-beta@0.4.0', kind: KIND_INSTALLED, provenance: PROVENANCE.installResult, at: at(1) }, deviceId),
    buildEntry({ packageName: 'dsh-live-test-git', version: '0.0.0-git', installSpec: 'github:acme/live-test-git#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', kind: KIND_INSTALLED, provenance: PROVENANCE.installResult, at: at(2) }, deviceId),
    // link 来源：故意把本机路径写进 installSpec，验证它**不会**被带进云文件。
    buildEntry({ packageName: 'dsh-live-test-local', version: '0.1.0', installSpec: 'link:C:/somewhere/live-test-local', kind: KIND_INSTALLED, provenance: PROVENANCE.profileScan, at: at(3) }, deviceId),
  ]
}

const rootTransport = createBaiduTransport({ token: TOKEN, remoteDir: TEST_REMOTE_DIR, onWarn: () => {} })
const realTransport = createBaiduTransport({ token: TOKEN, remoteDir: REAL_REMOTE_DIR, onWarn: () => {} })

try {
  /* ------------------------------------------------------------ 准备 */
  section('准备')
  const account = await rootTransport.getAccount()
  check('能读到网盘账号', account.uk !== null, `netdisk=${account.netdiskName ?? '?'}`)
  console.log(`       网盘账号：${account.netdiskName ?? '(未命名)'}  uk=${String(account.uk).slice(0, 4)}…`)
  console.log(`       测试目录：${TEST_REMOTE_DIR}（真实目录 ${REAL_REMOTE_DIR} 不会被碰）`)

  // 先清掉上次跑剩的痕迹（幂等）。
  const leftovers = await rootTransport.listReplicas().catch(() => [])
  for (const item of leftovers) await rootTransport.deleteReplica(item.name).catch(() => {})
  check('起步时测试目录是干净的', (await rootTransport.listReplicas().catch(() => [])).length === 0)

  /* ------------------------------------------------- 设备 A 首次推送 */
  section('设备 A：装上 4 个插件并推送')
  const homeA = newHome('deviceA')
  const deviceA = useDevice(homeA, '设备A-台式机')
  check('设备 A 生成了独立设备 ID', /^[0-9a-f-]{36}$/.test(deviceA.deviceId), deviceA.deviceId)
  check('设备 A 的账本起始为空', loadHistory(deviceA.deviceId).entries.length === 0)

  appendEntries(seedEntries(deviceA.deviceId))
  check('设备 A 本地记了 4 条', loadHistory(deviceA.deviceId).entries.length === 4)

  const engineA = makeEngine({ current: new Map([['dsh-live-test-alpha', '1.2.3']]) })
  check('推送前标记为有待推送变化', engineA.hasPendingChanges() === true)
  const pushedA = await engineA.push()
  check('设备 A 推送成功', pushedA.ok === true, JSON.stringify(pushedA).slice(0, 200))
  check('推送后没有待推送变化', engineA.hasPendingChanges() === false)
  check('推送时间被记下', engineA.status().lastPushAt !== null)

  const replicasAfterA = await rootTransport.listReplicas()
  check('云端出现 1 份副本', replicasAfterA.length === 1, replicasAfterA.map(item => item.name).join(','))
  check('副本名就是设备 ID', replicasAfterA[0]?.name === `${deviceA.deviceId}.json`, replicasAfterA[0]?.name)

  const location = await rootTransport.readLocation()
  check('写下了目录指针 location.json', location !== null && location.schemaVersion === 1, JSON.stringify(location))

  const rawA = await rootTransport.readReplica(`${deviceA.deviceId}.json`)
  const textA = rawA.toString('utf8')
  check('副本内容能被解析', (() => { try { return JSON.parse(textA).entries.length === 4 } catch { return false } })())
  check('副本里没有 token', !textA.includes(TOKEN))
  check('副本里没有本机路径', !textA.includes('C:/somewhere'), 'link 安装只应记包名与版本')

  /* ------------------------------------------- 设备 B 全新机器拉取 */
  section('设备 B：全新机器，先看到 A 的历史')
  const homeB = newHome('deviceB')
  const deviceB = useDevice(homeB, '设备B-笔记本')
  check('设备 B 的设备 ID 与 A 不同', deviceB.deviceId !== deviceA.deviceId, deviceB.deviceId)
  check('设备 B 本地账本为空（还没装过任何插件）', loadHistory(deviceB.deviceId).entries.length === 0)

  const engineB = makeEngine()
  const pulledB = await engineB.pull({ force: true })
  check('设备 B 拉取成功', pulledB.ok === true, JSON.stringify(pulledB).slice(0, 200))
  check('拉到 1 台设备的副本', pulledB.devices.length === 1, JSON.stringify(pulledB.devices?.map(device => device.deviceId)))
  check('没有跳过任何文件', (pulledB.skipped ?? []).length === 0, JSON.stringify(pulledB.skipped))

  const viewB = engineB.mergedView()
  check('合并出 4 行', viewB.rows.length === 4, viewB.rows.map(row => row.packageName).join(','))
  check('看到 1 台设备（A）', viewB.devices.length === 1, JSON.stringify(viewB.devices))
  check('设备名跟着一起同步过来了', viewB.devices[0]?.label === '设备A-台式机', String(viewB.devices[0]?.label))

  const rowAlpha = viewB.rows.find(row => row.packageName === 'dsh-live-test-alpha')
  check('registry 行可重装', rowAlpha?.reinstallable === true && rowAlpha?.installSpec === 'dsh-live-test-alpha@1.2.3', JSON.stringify(rowAlpha?.installSpec))
  check('A 上装过的行在 B 这里标为缺失', rowAlpha?.present === false, String(rowAlpha?.present))
  const rowGit = viewB.rows.find(row => row.packageName === 'dsh-live-test-git')
  check('git 来源被识别', rowGit?.sourceType === 'git', String(rowGit?.sourceType))
  const rowLocal = viewB.rows.find(row => row.packageName === 'dsh-live-test-local')
  check('link 来源标为不可重装', rowLocal?.reinstallable === false, String(rowLocal?.reinstallable))
  check('B 没有把自己写进云端', (await rootTransport.listReplicas()).length === 1)

  const cachePath = join(homeB, 'history-plugin', 'accounts', String(account.uk), 'remote.json')
  const cache = readJsonFile(cachePath, null)
  check('远端缓存按账号分目录落盘', existsSync(cachePath), cachePath)
  check('缓存里确实是 A 的那份文档', (cache?.documents ?? []).some(document => document.deviceId === deviceA.deviceId))

  /* ------------------------------------- 设备 B 装一个，A 再拉回来 */
  section('设备 B 装上自己的插件，A 再拉一次')
  appendEntries([buildEntry({ packageName: 'dsh-live-test-from-b', version: '9.9.9', installSpec: 'dsh-live-test-from-b@9.9.9', kind: KIND_INSTALLED, provenance: PROVENANCE.installResult, at: at(10) }, deviceB.deviceId)])
  const pushedB = await engineB.push()
  check('设备 B 推送成功', pushedB.ok === true, JSON.stringify(pushedB).slice(0, 200))
  check('云端现在有 2 份副本', (await rootTransport.listReplicas()).length === 2)

  const pulledA = await engineA.pull({ force: true })
  check('设备 A 拉取成功', pulledA.ok === true, JSON.stringify(pulledA).slice(0, 200))
  check('A 看到 2 台设备', pulledA.devices.length === 2, JSON.stringify(pulledA.devices?.map(device => device.deviceId)))
  const viewA = engineA.mergedView()
  check('A 的合并视图有 5 行', viewA.rows.length === 5, viewA.rows.map(row => row.packageName).join(','))
  check('A 能看到 B 装的那个插件', viewA.rows.some(row => row.packageName === 'dsh-live-test-from-b'))
  const rowFromB = viewA.rows.find(row => row.packageName === 'dsh-live-test-from-b')
  check('来自 B 的行只挂在 1 台设备上', rowFromB?.deviceCount === 1, String(rowFromB?.deviceCount))
  check('A 自己那条仍然在', viewA.rows.find(row => row.packageName === 'dsh-live-test-alpha')?.present === true)
  check('A 上没装的（B 的）标为缺失', rowFromB?.present === false, String(rowFromB?.present))

  /* ------------------------------------------------- 离线 → 重连 */
  section('离线推送失败后重连能补上')
  // 必须切回设备 A 的家目录：引擎的设备身份与账本都跟着 DSH_HOME 走，
  // 忘了切就会拿 B 的身份去测 A 的补传（第一版就踩了这个坑）。
  useDevice(homeA, '设备A-台式机')
  const engineBad = makeEngine({ token: 'definitely-not-a-valid-token', current: new Map() })
  const failedPush = await engineBad.push()
  check('坏 token 推送如实失败', failedPush.ok === false, JSON.stringify(failedPush).slice(0, 160))
  check('失败被记进状态', engineBad.status().lastError !== null)
  check('失败后仍然标记有待推送变化', engineBad.hasPendingChanges() === true)

  const afterFailure = await rootTransport.readReplica(`${deviceA.deviceId}.json`)
  check('失败的推送没有破坏云端已有副本', JSON.parse(afterFailure.toString('utf8')).entries.length === 4, String(JSON.parse(afterFailure.toString('utf8')).entries.length))

  appendEntries([buildEntry({ packageName: 'dsh-live-test-offline', version: '2.0.0', installSpec: 'dsh-live-test-offline@2.0.0', kind: KIND_INSTALLED, provenance: PROVENANCE.installResult, at: at(20) }, deviceA.deviceId)])
  const retried = await engineA.push()
  check('换回有效 token 后推送成功', retried.ok === true, JSON.stringify(retried).slice(0, 160))
  check('推送后待推送变化清零', engineA.hasPendingChanges() === false)
  const afterRetry = JSON.parse((await rootTransport.readReplica(`${deviceA.deviceId}.json`)).toString('utf8'))
  check('补上的那条确实进了云端', afterRetry.entries.some(entry => entry.packageName === 'dsh-live-test-offline'), String(afterRetry.entries.length))
  check('云端是 5 条', afterRetry.entries.length === 5, String(afterRetry.entries.length))

  /* --------------------------------------------------------- 收尾 */
  section('清理')
  for (const item of await rootTransport.listReplicas()) {
    await rootTransport.deleteReplica(item.name).catch(error => console.log(`  warn 删副本失败：${redactToken(error?.message)}`))
  }
  await rootTransport.deletePath(`${TEST_REMOTE_DIR}/v1/replicas`).catch(() => {})
  await rootTransport.deletePath(`${TEST_REMOTE_DIR}/v1`).catch(() => {})
  await rootTransport.deletePath(`${TEST_REMOTE_DIR}/location.json`).catch(() => {})
  await rootTransport.deletePath(TEST_REMOTE_DIR).catch(() => {})

  const remaining = await rootTransport.listReplicas().catch(() => null)
  check('测试目录里已无副本', remaining !== null && remaining.length === 0, remaining === null ? '列举失败' : String(remaining.length))
  const rootLeft = await rootTransport.listRoot().catch(() => null)
  check('测试目录本身已删掉', rootLeft !== null && !rootLeft.some(item => item.name === TEST_REMOTE_DIR.slice(1)), rootLeft === null ? '列举失败' : rootLeft.map(item => item.name).join(','))

  const realListing = await realTransport.listRoot().catch(() => null)
  const realReplicas = await realTransport.listReplicas().catch(() => null)
  check('真实目录没有被塞进测试副本', (realReplicas ?? []).every(item => !item.name.includes('live-test')), JSON.stringify(realReplicas?.map(item => item.name)))
  console.log(`       真实目录 ${REAL_REMOTE_DIR}：${realListing === null ? '列举失败' : `${realListing.length} 项`}，副本 ${realReplicas === null ? '?' : realReplicas.length} 份`)

  for (const engine of [engineA, engineB, engineBad]) engine.dispose()
} catch (error) {
  failed += 1
  console.log(`\nFAIL   真实链路异常 — ${redactToken(error?.message ?? String(error))}`)
  console.log(`       step=${error?.step ?? 'null'} code=${error?.code ?? 'null'}`)
} finally {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed（真实网盘，两台设备，token 未打印）`)
process.exit(failed === 0 ? 0 : 1)
