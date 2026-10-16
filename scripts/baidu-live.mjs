/**
 * 真实链路验收：用插件自己的传输层，在真实百度网盘上跑完整来回。
 *
 * 探针脚本是手写的，不能证明 lib/baidu.js 本身可用；这个脚本专门验后者。
 * 需要凭据，所以是「显式开启」而非默认测试：
 *
 *   BAIDU_TOKEN_FILE=<临时 token 文件> node scripts/baidu-live.mjs
 *
 * 验证内容（每一项都对应一个实测过的坑）：
 *   1. 建目录不产生重名副本目录
 *   2. 写入后按文件名可列出、可读回、内容逐字节一致
 *   3. 更新同一份副本后读回的是新内容（先删再传 + 不缓存 fs_id）
 *   4. 更新不会留下 name(1).json 之类的副本
 *   5. 删除幂等
 *
 * 只操作自己创建的 live-*.json，跑完必删；token 不落盘、不打印。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createBaiduTransport } from '../lib/baidu.js'

const TOKEN_FILE = process.env.BAIDU_TOKEN_FILE
if (typeof TOKEN_FILE !== 'string' || TOKEN_FILE.trim() === '') {
  console.error('未设置 BAIDU_TOKEN_FILE；这是需要真实凭据的验收，必须显式开启。')
  process.exit(2)
}
const token = readFileSync(TOKEN_FILE, 'utf8').trim()
if (token === '') {
  console.error('token 文件为空')
  process.exit(2)
}

/** 输出前统一脱敏。 */
const redact = text => String(text).replaceAll(token, '***').replace(/(access_token=)[^&\s"']+/g, '$1***')
let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL   ${label}${detail === undefined ? '' : ` — ${redact(detail)}`}`)
  }
}

const marker = `live-${randomUUID()}`
const name = `${marker}.json`
const first = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1, marker }), 'utf8')
const second = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 2, marker, padding: 'x'.repeat(40) }), 'utf8')

const transport = createBaiduTransport({
  token,
  remoteDir: process.env.BAIDU_REMOTE_DIR ?? '/dsh-history-plugin',
  retries: 2,
  onWarn: message => console.log(`  warn ${redact(message)}`),
})

let written = false
try {
  /* 0. 账号标识：本地缓存按它隔离，换账号绝不能串数据。 */
  const account = await transport.getAccount()
  const maskedUk = typeof account.uk === 'string' && account.uk.length > 4
    ? `${account.uk.slice(0, 4)}…`
    : '(无)'
  console.log(`网盘账号：${account.netdiskName ?? account.baiduName ?? '(未命名)'}  uk=${maskedUk}`)
  check('能读到账号稳定标识 uk', typeof account.uk === 'string' && account.uk !== '', String(account.uk))

  const replicasDir = await transport.ensureDirs()
  console.log(`副本目录：${replicasDir}`)

  /* 1. 写入。 */
  const created = await transport.writeReplica(name, first)
  written = true
  check('首次写入成功', Number(created.size) === first.length, `size=${created.size}`)

  /* 2. 列出 + 读回。 */
  const listed = await transport.listReplicas()
  const found = listed.filter(item => item.name === name)
  check('按文件名可列出', found.length === 1, `命中 ${found.length} 个`)
  const readBack = await transport.readReplica(name)
  check('读回内容逐字节一致', readBack !== null && readBack.equals(first), readBack === null ? 'null' : `${readBack.length} 字节`)

  /* 3. 覆盖更新：这一步同时验证「先删再传」与「不缓存 fs_id」。 */
  await transport.writeReplica(name, second)
  const updated = await transport.readReplica(name)
  check('更新后读回新内容', updated !== null && updated.equals(second), updated?.toString('utf8').slice(0, 60))
  check('更新后内容确实变了', updated !== null && !updated.equals(first))

  /* 4. 目录里不能出现副本文件或副本目录。 */
  const afterUpdate = await transport.listReplicas()
  const duplicates = afterUpdate.filter(item => item.name.startsWith(marker) && item.name !== name)
  check('未留下 (1) 之类的副本文件', duplicates.length === 0, duplicates.map(item => item.name).join(','))
  const sameNameCount = afterUpdate.filter(item => item.name === name).length
  check('同名文件仍然只有一个', sameNameCount === 1, `有 ${sameNameCount} 个`)

  /* 目录级检查：rtype=1 的坑会在副本目录旁边生成带时间戳的兄弟目录。 */
  const rootListing = await transport.listRoot()
  const strayDirs = rootListing.filter(item => item.isDir && /_\d{8}_\d{6}$/.test(item.name))
  check('根目录没有被建出带时间戳的副本目录', strayDirs.length === 0, strayDirs.map(item => item.name).join(','))

  /* 5. 删除幂等。 */
  const removed = await transport.deleteReplica(name)
  check('删除成功', removed.removed === true)
  const gone = await transport.readReplica(name)
  check('删除后读不到', gone === null)
  const removedAgain = await transport.deleteReplica(name)
  check('重复删除不报错', removedAgain.removed === false)
} catch (error) {
  failed += 1
  console.log(`FAIL   真实链路异常 — ${redact(error?.message ?? String(error))}`)
  console.log(`       code=${error?.code ?? 'null'} step=${error?.step ?? 'null'}`)
} finally {
  if (written) {
    await transport.deleteReplica(name).catch(error => console.log(`  warn 清理失败：${redact(error?.message)}`))
  }
  const remaining = await transport.listReplicas()
    .then(items => items.filter(item => item.name.startsWith('live-')).map(item => item.name))
    .catch(() => ['<列举失败>'])
  console.log(`\n剩余 live-* 文件：${remaining.length === 0 ? '无' : remaining.join(', ')}`)
}

console.log(`\n${passed} passed, ${failed} failed（真实网盘，token 未打印）`)
process.exit(failed === 0 ? 0 : 1)
