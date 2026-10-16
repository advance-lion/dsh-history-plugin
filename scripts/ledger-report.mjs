/**
 * 只读预演：本机账本「应该」记成什么样。
 *
 * 用真实的 profile（依赖表 + 版本 + 市场日志）在**临时 DSH_HOME** 里跑一遍完整
 * 采集流程，因此不会触碰线上账本。用途有两个：
 *   - 开发期验收：确认重建结果干净（无重复、来源类型正确）
 *   - 排障：怀疑账本记错时，先看这个脚本的结论，再看线上文件
 *
 * 用法：node scripts/ledger-report.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profileDir = process.env.DSH_PROFILE_DIR
if (typeof profileDir !== 'string' || profileDir.trim() === '') {
  console.error('需要 DSH_PROFILE_DIR（本会话通常已设置）。')
  process.exit(2)
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-history-report-'))
process.env.DSH_HOME = sandbox

const store = await import('../lib/store.js')
const collector = await import('../lib/collector.js')

/** 读某个已安装包的真实版本。 */
function installedVersion(name) {
  try {
    const raw = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

const dependencies = collector.readProfileManifest(profileDir).dependencies
// 忠实还原 listBundles 的语义：profile 依赖 = installed；第三方 = removable。
// 官方/预装用 removable:false 表达（它们不在 profile 依赖表里）。
const bundles = Object.keys(dependencies).map(name => ({
  name,
  version: installedVersion(name) ?? undefined,
  installed: true,
  removable: true,
  enabled: true,
}))
bundles.push(
  { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', installed: false, removable: false, enabled: true },
  { name: '@deepseek-ai/dsh-web-app', version: '0.2.0-rc.2', installed: false, removable: false, enabled: true },
)

const collectorInstance = collector.createCollector({
  getManager: () => ({ listBundles: async () => bundles }),
  profileDir,
})

await collectorInstance.start()
await collectorInstance.start() // 第二轮：验证幂等（重复核对不应新增任何条目）

const history = store.loadHistory()
const rows = store.aggregateByPackage(history.entries)
const device = store.loadDevice()

console.log(`设备：${device.deviceLabel ?? '(未命名)'}  ${device.deviceId}`)
console.log(`profile：${profileDir}`)
console.log(`事件总数：${history.entries.length}（依赖 ${Object.keys(dependencies).length} 个，排除插件自身）\n`)

const pad = (text, width) => String(text ?? '-').padEnd(width)
console.log(`${pad('包名', 26)} ${pad('版本', 10)} ${pad('来源', 9)} ${pad('可重装', 7)} ${pad('证据', 13)} 时间`)
for (const row of rows) {
  const latest = row.events[0]
  console.log([
    pad(row.packageName, 26),
    pad(row.version, 10),
    pad(latest.sourceType, 9),
    pad(String(latest.reinstallable), 7),
    pad(latest.provenance, 13),
    store.timestampOf(latest),
  ].join(' '))
  for (const event of row.events.slice(1)) {
    console.log(`${pad('  ↳ 更早', 26)} ${pad(event.version, 10)} ${pad(event.sourceType, 9)} ${pad(String(event.reinstallable), 7)} ${pad(event.provenance, 13)} ${store.timestampOf(event)}`)
  }
}

// 断言：这份账本必须干净，否则重建结果不可信。
const identity = entry => `${entry.provenance}|${entry.packageName}|${store.timestampOf(entry)}`
const seen = new Map()
for (const entry of history.entries) seen.set(identity(entry), (seen.get(identity(entry)) ?? 0) + 1)
const duplicates = [...seen.entries()].filter(([, count]) => count > 1)
const selfRecorded = history.entries.filter(entry => entry.packageName === 'dsh-history-plugin')
const localMisclassified = history.entries.filter(
  entry => collector.readProfileManifest(profileDir).dependencies[entry.packageName]?.startsWith('link:') && entry.reinstallable !== false,
)

console.log('')
let failed = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}
check('无重复补录条目', duplicates.length === 0, JSON.stringify(duplicates))
check('未记录插件自身', selfRecorded.length === 0)
check('link 安装的包标为不可重装', localMisclassified.length === 0, localMisclassified.map(e => e.packageName).join(','))
check('每个事件都有设备 ID', history.entries.every(entry => entry.deviceId === device.deviceId))
check('每个事件时间戳可解析', history.entries.every(entry => Number.isFinite(Date.parse(store.timestampOf(entry)))))
check('可由本机上传文档校验通过', store.validateRemoteDocument(store.buildUploadDocument(device.deviceLabel)) !== null)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '账本重建结果干净' : `${failed} 项不通过`}`)
process.exit(failed === 0 ? 0 : 1)
