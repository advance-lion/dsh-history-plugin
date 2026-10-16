/**
 * 本机 profile 端到端验收：对着**真正在跑的 DSH 宿主**打自己的 HTTP 接口。
 *
 * 与其它套件的分工：那些套件用假的宿主/假的网盘验证逻辑；这一个验证
 * 「代码真的被宿主加载了、接口真的通了、账本真的重建了」——也就是只有重启之后
 * 才能做的最后一公里。
 *
 * 两种失败要分清，所以退出码分开：
 *   0 = 通过（未授权网盘这类「如实降级」不算失败，会标成 SKIP）
 *   1 = 验收失败（有 HARD 断言不通过，说明真的坏了）
 *   2 = 宿主还没跑新代码（API 404）——**这不是失败，是需要重启 DSH**
 *
 * 只读为主：唯一的写请求是 `POST /sync`（已授权时才发）与
 * `POST /reinstall {dryRun:true}`（契约上明确不改动任何东西）。
 *
 * 用法：node scripts/accept-local.mjs
 * 端口可用 DSH_HISTORY_HOST_URL 覆盖（默认 http://127.0.0.1:19387）。
 */

import { readFileSync } from 'node:fs'
import { dataFile, fileExists } from '../lib/util.js'

const BASE = process.env.DSH_HISTORY_HOST_URL ?? 'http://127.0.0.1:19387'
const API = `${BASE}/dsh-history-plugin/api/v1`
const REPORT_PATH = new URL('../_probe/out/accept-local.md', import.meta.url)

let passed = 0
let failed = 0
let skipped = 0
const report = []

const line = text => {
  console.log(text)
  report.push(text)
}
const section = title => line(`\n== ${title} ==`)
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    line(`  ok   ${label}`)
  } else {
    failed += 1
    line(`FAIL   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function skip(label, why) {
  skipped += 1
  line(`  skip ${label} — ${why}`)
}

/**
 * 打本机接口。
 * @param {string} path 路径。
 * @param {{ method?: string, body?: object }} [options] 选项。
 * @returns {Promise<{ status: number, json: any, text: string }>} 响应。
 */
async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** 任何响应里都不该出现的本机路径痕迹。 */
const LOCAL_PATH_PATTERN = /[A-Za-z]:\\\\|[A-Za-z]:\\|\/Users\/|\/home\//
/** token 类字段名，出现即视为泄露。 */
const SECRET_PATTERN = /access_token|accessToken|refresh_token|refreshToken|Bearer\s/i

/* ------------------------------------------------------------ 0. 宿主在不在 */
section('0. 宿主是否已加载本插件（决定后面能不能测）')
const status = await call('/status')
if (status.status === 404) {
  line('  宿主返回 404：本插件的接口还没注册。')
  line('  结论：DSH 仍在跑旧代码，**需要重启 DSH**（客户端入口与 lib 代码都是启动时读的）。')
  line('  这不是验收失败，退出码 2。')
  process.exit(2)
}
check('GET /status 返回 200', status.status === 200, `HTTP ${status.status} ${status.text.slice(0, 120)}`)
if (status.status !== 200) {
  line(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(1)
}
line('  宿主已加载本插件的新代码。')

/* --------------------------------------------------------------- 1. 状态 */
section('1. 状态：设备 / 配置 / 凭据')
{
  const payload = status.json
  check('响应是 JSON 且 ok=true', payload?.ok === true, status.text.slice(0, 120))
  check('接口前缀正确', payload?.api?.prefix === '/dsh-history-plugin/api/v1', String(payload?.api?.prefix))
  check('同步目录是真实目录', payload?.sync?.remoteDir === '/dsh-history-plugin', String(payload?.sync?.remoteDir))

  const deviceId = payload?.device?.deviceId
  check('带上了本机设备 ID', typeof deviceId === 'string' && deviceId.length > 0, String(deviceId))
  check('设备 ID 是 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(deviceId)), String(deviceId))
  if (fileExists(dataFile('device.json'))) {
    const onDisk = JSON.parse(readFileSync(dataFile('device.json'), 'utf8'))
    check('接口报的设备 ID 与 device.json 一致', onDisk.deviceId === deviceId, `${onDisk.deviceId} vs ${deviceId}`)
  } else {
    check('device.json 已落盘', false, '文件缺失')
  }

  check('凭据只报状态、不回传值', payload?.credential !== undefined
    && !JSON.stringify(payload.credential).match(SECRET_PATTERN), JSON.stringify(payload?.credential))
  check('整个状态响应里没有 token 字段', !status.text.match(SECRET_PATTERN), '命中敏感字段名')
  check('状态响应里没有本机路径', !status.text.match(LOCAL_PATH_PATTERN), '命中路径痕迹')
}

/* --------------------------------------------------------------- 2. 历史 */
section('2. 历史：跨设备合并后的行')
let historyRows = []
{
  const history = await call('/history')
  check('GET /history 返回 200', history.status === 200, `HTTP ${history.status}`)
  const payload = history.json
  historyRows = Array.isArray(payload?.rows) ? payload.rows : []
  check('返回了行', historyRows.length >= 1, `rows=${historyRows.length}`)
  // 不写死 9：这是本机 profile 当前的规模，用户增删插件后自然变化。
  // 阈值只用来发现「账本几乎空的」这种异常。
  check('行数达到本机已装插件的规模', historyRows.length >= 5, `rows=${historyRows.length}`)
  check('每行都有包名', historyRows.every(row => typeof row.packageName === 'string' && row.packageName !== ''))
  check('每行都至少属于一台设备', historyRows.every(row => row.deviceCount >= 1))
  // 本地聚合按最新时间倒序（store.js 里排过）；合并过云端副本时顺序由合并逻辑决定，
  // 那种情况不在这里断言，避免把「合并顺序」误报成本机验收失败。
  if (payload?.synced === true) {
    skip('行按最近时间倒序', '已合并云端副本，顺序由合并逻辑决定')
  } else {
    check('行按最近时间倒序', historyRows.every((row, index) => index === 0
      || String(historyRows[index - 1].latestAt ?? '') >= String(row.latestAt ?? '')))
  }

  // 诚实性：只有 discovered 记录的行，绝不能凭空造一个安装时间。
  const fabricated = historyRows.filter(row => {
    const entries = Array.isArray(row.entries) ? row.entries : []
    const hasInstalled = entries.some(entry => entry?.kind === 'installed')
    return !hasInstalled && row.lastInstalledAt !== null && row.lastInstalledAt !== undefined
  })
  check('没有安装记录的行不编造安装时间', fabricated.length === 0, fabricated.map(row => row.packageName).join(', '))

  // 本地 link/file 装的东西不能在别的机器上复现，所以既不留 spec 也不许标成可装。
  const localLeaks = historyRows.filter(row => row.sourceType === 'local' && row.installSpec !== null)
  check('本地来源的行不留安装 spec', localLeaks.length === 0, localLeaks.map(row => row.packageName).join(', '))
  check('本地来源的行标为不可重装', historyRows.every(row => row.sourceType !== 'local' || row.reinstallable === false))
  check('历史响应里没有本机路径', !history.text.match(LOCAL_PATH_PATTERN), '命中路径痕迹')
  check('历史响应里没有 token 字段', !history.text.match(SECRET_PATTERN), '命中敏感字段名')

  const kinds = new Set(historyRows.flatMap(row => (row.entries ?? []).map(entry => entry?.kind)))
  line(`  行数 ${historyRows.length}；出现的事件类型：${[...kinds].join(', ') || '(无明细)'}；可重装 ${historyRows.filter(row => row.reinstallable).length} 行`)
}

/* --------------------------------------------------------------- 3. 设备 */
section('3. 设备清单')
{
  const devices = await call('/devices')
  check('GET /devices 返回 200', devices.status === 200, `HTTP ${devices.status}`)
  const list = Array.isArray(devices.json?.devices) ? devices.json.devices : []
  check('至少列出本机一台设备', list.length >= 1, `devices=${list.length}`)
  check('本机设备在清单里', list.some(item => item.deviceId === devices.json?.deviceId))
  // 空账本的设备不该算一台设备（否则新机器会谎报「2 台设备」）。
  const emptyDevices = list.filter(item => !(item.entries > 0))
  check('清单里没有 0 条目的设备', emptyDevices.length === 0, JSON.stringify(emptyDevices))
  line(`  设备：${list.map(item => `${item.deviceLabel ?? '(未命名)'}/${item.entries}条`).join('、')}`)
}

/* --------------------------------------------------------------- 4. 同步 */
section('4. 云同步（未授权时如实跳过）')
{
  const configured = status.json?.credential?.configured === true
  if (!configured) {
    skip('POST /sync', '网盘未授权：这是旧临时 token 路径之外的正常状态，不算失败')
    skip('云端副本可见性', '未授权时不会去读云')
  } else {
    const synced = await call('/sync', { method: 'POST', body: {} })
    check('POST /sync 返回 200', synced.status === 200, `HTTP ${synced.status} ${synced.text.slice(0, 160)}`)
    const pulled = synced.json?.pulled
    const pushed = synced.json?.pushed
    check('拉取成功', pulled?.ok === true, JSON.stringify(pulled))
    check('推送成功', pushed?.ok === true, JSON.stringify(pushed))
    check('同步响应里没有 token', !synced.text.match(SECRET_PATTERN), '命中敏感字段名')
    if (pulled?.ok === true) {
      line(`  拉到 ${pulled.deviceCount} 台设备 / ${pulled.pluginCount} 个插件；推送 ${pushed?.entries ?? 0} 条 / ${pushed?.bytes ?? 0} 字节`)
    }
    const after = await call('/devices')
    check('同步后设备清单仍不含 0 条目设备',
      (after.json?.devices ?? []).every(item => item.entries > 0),
      JSON.stringify(after.json?.devices))
  }
}

/* ----------------------------------------------------------- 5. 批量重装 */
section('5. 批量重装（只做预检，不真装）')
{
  const target = historyRows.find(row => row.reinstallable === true && row.present === false)
    ?? historyRows.find(row => row.reinstallable === true)
  if (target === undefined) {
    skip('POST /reinstall dryRun', '当前没有可重装的行（都是本地来源或缺少来源）')
  } else {
    const planned = await call('/reinstall', { method: 'POST', body: { dryRun: true, packages: [target.packageName] } })
    check('预检返回 200', planned.status === 200, `HTTP ${planned.status} ${planned.text.slice(0, 160)}`)
    check('明确标了这是预检', planned.json?.dryRun === true, JSON.stringify(planned.json?.dryRun))
    const items = Array.isArray(planned.json?.planned) ? planned.json.planned : []
    check('预检返回了逐条结果', items.length === 1, `planned=${items.length}`)
    check('预检状态是已知取值', ['ready', 'refused', 'unknown'].includes(items[0]?.status), String(items[0]?.status))
    check('预检响应里没有 token', !planned.text.match(SECRET_PATTERN))
    // 「预检」这个词必须名副其实：它不该改动任何东西，所以结果里不该出现安装动作的痕迹。
    check('预检没有执行安装', planned.json?.dryRun === true && !('installed' in (planned.json ?? {})), JSON.stringify(Object.keys(planned.json ?? {})))
    line(`  目标 ${target.packageName} → ${items[0]?.status}${items[0]?.reason ? `（${items[0].reason}）` : ''}`)

    const unknown = await call('/reinstall', { method: 'POST', body: { dryRun: true, packages: ['this-package-does-not-exist-xyz'] } })
    check('未知包名如实回报 unknown', Array.isArray(unknown.json?.unknown) && unknown.json.unknown.length === 1, JSON.stringify(unknown.json?.unknown))
  }
  const noPackages = await call('/reinstall', { method: 'POST', body: { dryRun: true, packages: [] } })
  check('空清单被拒绝（500 且可读）', noPackages.status === 500 && String(noPackages.json?.error).includes('重装'), `HTTP ${noPackages.status} ${noPackages.text.slice(0, 120)}`)
}

/* -------------------------------------------------------- 6. 账本与日志 */
section('6. 本机账本文件与日志')
{
  const historyPath = dataFile('history.json')
  check('history.json 已重建', fileExists(historyPath), historyPath)
  if (fileExists(historyPath)) {
    const raw = readFileSync(historyPath, 'utf8')
    let ledger = null
    try {
      ledger = JSON.parse(raw)
    } catch (error) {
      ledger = null
      line(`  解析失败：${error.message}`)
    }
    check('history.json 是合法 JSON', ledger !== null)
    check('schemaVersion = 1', ledger?.schemaVersion === 1, String(ledger?.schemaVersion))
    const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
    check('账本里有事件', entries.length >= 1, `entries=${entries.length}`)
    const localId = status.json?.device?.deviceId
    const foreign = entries.filter(entry => entry?.deviceId !== localId)
    check('本机账本只装本机设备的事件', foreign.length === 0, `${foreign.length} 条来自别的设备`)
    check('账本里没有 token', !raw.match(SECRET_PATTERN))
    check('账本里没有本机路径', !raw.match(LOCAL_PATH_PATTERN))
    check('每条事件都有来源类型与键', entries.every(entry => typeof entry?.sourceType === 'string' && typeof entry?.key === 'string'))
    line(`  事件 ${entries.length} 条；类型分布 ${JSON.stringify(entries.reduce((acc, entry) => ({ ...acc, [entry.kind]: (acc[entry.kind] ?? 0) + 1 }), {}))}`)
  }

  check('state.json 已落盘', fileExists(dataFile('state.json')))

  const logPath = dataFile('plugin.log')
  if (fileExists(logPath)) {
    const log = readFileSync(logPath, 'utf8')
    check('日志记录了接口就绪与路由数量', /http-api-ready.*9 paths \/ 10 methods/.test(log),
      log.split('\n').filter(item => item.includes('http-api-ready')).join(' | ').slice(0, 200))
    check('日志记录了采集启动', log.includes('collector-start'))
    check('日志里没有 token', !log.match(SECRET_PATTERN))
    const lines = log.trim().split('\n')
    line(`  日志最后一条：${lines[lines.length - 1]?.slice(0, 160)}`)
  } else {
    check('plugin.log 存在', false, logPath)
  }
}

/* ---------------------------------------------------------------- 收尾 */
line(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) line('结论：验收未通过。')
else line(`结论：本机 profile 端到端验收通过${skipped > 0 ? '（有项按未授权如实跳过）' : ''}。`)

try {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(new URL('../_probe/out/', import.meta.url), { recursive: true })
  writeFileSync(REPORT_PATH, `# 本机验收记录\n\n目标：${API}\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`, 'utf8')
  console.log(`报告已写入 ${REPORT_PATH.pathname}`)
} catch (error) {
  console.log(`报告写入失败：${error.message}`)
}

process.exit(failed === 0 ? 0 : 1)
