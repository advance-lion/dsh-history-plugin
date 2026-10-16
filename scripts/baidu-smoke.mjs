/**
 * 传输层回归测试：用模拟网盘服务器复现实测出来的全部怪癖。
 *
 * 这里每一条断言都对应一个真实踩过的坑，而不是照文档假设：
 *   - rtype=1 建目录会生成重名副本目录
 *   - rtype=2「覆盖」实际生成 name(1).json，原文件不动
 *   - 覆盖写换 fs_id，缓存 fs_id 会读到旧内容
 *   - 分片上传成功时不返回 errno 字段
 *   - 下载 dlink 必须带 User-Agent 与 access_token
 *
 * 全部离线，不碰真实网盘。真实链路验收见 scripts/baidu-live.mjs。
 *
 * 用法：node scripts/baidu-smoke.mjs
 */

import { createHash } from 'node:crypto'
import { BaiduError, MAX_REMOTE_BYTES, createBaiduTransport } from '../lib/baidu.js'
import { MIGRATE_STATUS, createMigrator, validateRemoteDir } from '../lib/migrate.js'

const TOKEN = 'temp-token-0123456789abcdef'
/**
 * 真实网盘在 list/create 里返回的「md5」——含字母 v，不是十六进制，不是内容 md5。
 * 模拟服务器一律返回它，这样所有用例都在「该字段不可信」的前提下跑。
 */
const BOGUS_MD5 = 'a1d1adf8bv4209664168a63676f489e1'
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

/**
 * 模拟网盘服务器。
 * @param {{ renameOnConflict?: boolean, superfile2WithoutErrno?: boolean, dlinkWithoutToken?: boolean, failFirst?: number, md5Corrupt?: boolean }} [options] 行为开关。
 */
function makeServer(options = {}) {
  /** @type {Map<string, { bytes: Buffer, fsId: number, md5: string }>} */
  const files = new Map()
  const dirs = new Set(['/'])
  /** @type {object[]} */
  const calls = []
  let nextFsId = 1000
  let failuresLeft = options.failFirst ?? 0
  /** 最近一次分片上传的内容，等 create 合并时取用。 */
  let pendingUpload = null

  const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })
  const dirOf = path => path.slice(0, path.lastIndexOf('/')) || '/'
  const nameOf = path => path.slice(path.lastIndexOf('/') + 1)

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const query = Object.fromEntries(parsed.searchParams)
    const form = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null
    const method = query.method ?? null
    calls.push({
      host: parsed.host, path: parsed.pathname, method,
      rtype: form?.rtype ?? null,
      target: form?.path ?? query.path ?? null,
      hasToken: parsed.searchParams.has('access_token'),
    })

    if (failuresLeft > 0) {
      failuresLeft -= 1
      return new Response('server busy', { status: 500 })
    }

    /* 分片上传必须排在下载之前判断：真实环境里上传和下载同主机
       d.pcs.baidu.com，只是路径不同（/rest/2.0/pcs/superfile2 vs /rest/2.0/xpan/file）。 */
    if (parsed.pathname === '/rest/2.0/pcs/superfile2') {
      const blob = init.body?.get?.('file')
      const bytes = Buffer.from(await blob.arrayBuffer())
      const md5 = createHash('md5').update(bytes).digest('hex')
      pendingUpload = bytes
      // 真实行为：成功时不带 errno 字段。
      return json(options.superfile2WithoutErrno === false ? { errno: 0, md5 } : { md5, request_id: 123 })
    }

    /* 下载链路：dlink 指到另一个主机，模拟真实情况。 */
    if (parsed.host === 'd.pcs.baidu.com') {
      const wanted = query.fsid
      for (const [, entry] of files) {
        if (String(entry.fsId) === String(wanted)) {
          // truncateDownload 模拟下载被截断：字节数会与列目录不符。
          const bytes = options.truncateDownload ? entry.bytes.subarray(0, 3) : entry.bytes
          return new Response(bytes, { status: 200 })
        }
      }
      return new Response('not found', { status: 404 })
    }

    if (method === 'create' && form?.isdir === '1') {
      // 真实行为：已存在目录 + rtype=1 → errno 0，但旁边多出一个带时间戳的副本。
      const path = form.path
      if (dirs.has(path)) {
        if (options.renameOnConflict !== false && form.rtype === '1') {
          dirs.add(`${path}_20261013_111126`)
          return json({ errno: 0 })
        }
        return json({ errno: form.rtype === '0' ? -8 : 0 })
      }
      dirs.add(path)
      return json({ errno: 0 })
    }

    if (method === 'list') {
      const dir = query.dir
      if (!dirs.has(dir)) return json({ errno: -9 })
      const list = []
      for (const [path, entry] of files) {
        if (dirOf(path) !== dir) continue
        list.push({
          fs_id: entry.fsId, path, server_filename: nameOf(path),
          // 刻意返回网盘那个不可信的签名，而不是内容 md5。
          size: entry.bytes.length, md5: BOGUS_MD5, isdir: 0, server_mtime: 1,
        })
      }
      for (const extra of dirs) {
        if (extra !== dir && dirOf(extra) === dir) {
          list.push({ fs_id: -1, path: extra, server_filename: nameOf(extra), size: 0, isdir: 1, server_mtime: 1 })
        }
      }
      return json({ errno: 0, list })
    }

    if (method === 'precreate') {
      const size = Number(form.size)
      return json({ errno: 0, uploadid: `up-${nextFsId}`, return_type: 1, block_list: [0], _size: size })
    }

    if (method === 'create') {
      const path = form.path
      const size = Number(form.size)
      let targetPath = path
      if (files.has(path) && form.rtype === '2') {
        // 真实行为：声称覆盖，实际生成 name(1).json，原文件不动。
        targetPath = `${path}(1)`
      }
      const bytes = pendingUpload ?? Buffer.alloc(size)
      pendingUpload = null
      nextFsId += 1
      files.set(targetPath, { bytes, fsId: nextFsId, md5: createHash('md5').update(bytes).digest('hex') })
      return json({ errno: 0, fs_id: nextFsId, path: targetPath, size: bytes.length })
    }

    if (method === 'filemetas') {
      const wanted = JSON.parse(query.fsids)[0]
      for (const [, entry] of files) {
        if (String(entry.fsId) === String(wanted)) {
          const token = options.dlinkWithoutToken === false ? `?access_token=${TOKEN}` : ''
          return json({ errno: 0, list: [{ fs_id: entry.fsId, size: entry.bytes.length, dlink: `https://d.pcs.baidu.com/rest/2.0/xpan/file?fsid=${entry.fsId}${token}` }] })
        }
      }
      return json({ errno: 0, list: [] })
    }

    if (method === 'filemanager' && query.opera === 'delete') {
      const targets = JSON.parse(form.filelist)
      const info = targets.map(path => {
        if (files.has(path)) {
          files.delete(path)
          return { errno: 0, path }
        }
        if (dirs.has(path) && path !== '/') {
          const hasChild = [...files.keys(), ...dirs].some(item => item !== path && dirOf(item) === path)
          if (hasChild) return { errno: -9, path }
          dirs.delete(path)
          return { errno: 0, path }
        }
        return { errno: -9, path }
      })
      return json({ errno: 0, info })
    }

    return json({ errno: -1, unexpected: { path: parsed.pathname, method } })
  }

  return { fetchImpl, files, dirs, calls }
}

const replicas = server => [...server.files.keys()].filter(path => path.includes('/v1/replicas/'))

/* ------------------------------------------------------------ 建目录 */
section('建目录：rtype 必须为 0')
{
  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl })
  await transport.ensureDirs()
  const mkdirCalls = server.calls.filter(call => call.method === 'create' && call.rtype === '1')
  check('从未用 rtype=1 建目录', mkdirCalls.length === 0, `出现 ${mkdirCalls.length} 次`)
  check('逐级建出副本目录', server.dirs.has('/dsh-history-plugin/v1/replicas'))
  const stray = [...server.dirs].filter(dir => /_\d{8}_\d{6}$/.test(dir))
  check('没有重名副本目录', stray.length === 0, stray.join(','))

  // 第二次调用：目录已存在，必须把 errno -8 当成成功。
  const before = server.calls.length
  await createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl }).ensureDirs()
  const secondRun = server.calls.slice(before).filter(call => call.method === 'create' && call.rtype === '1')
  check('重复调用仍不用 rtype=1', secondRun.length === 0)
  check('已存在目录不再产生副本', [...server.dirs].filter(dir => /_\d{8}_\d{6}$/.test(dir)).length === 0)
}

/* -------------------------------------------------- 上传与「先删再传」 */
section('上传：先删再传，绝不依赖覆盖')
{
  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl })
  await transport.ensureDirs()
  const first = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1 }))
  await transport.writeReplica('device-a.json', first)

  check('写入后按名可列出', replicas(server).length === 1, replicas(server).join(','))
  check('写入路径无 (1) 后缀', replicas(server).every(path => !path.includes('(1)')), replicas(server).join(','))

  const rtypes = server.calls.filter(call => call.method === 'precreate' || call.method === 'create').map(call => call.rtype)
  check('上传全程 rtype 只有 0', rtypes.every(value => value === '0'), JSON.stringify(rtypes))

  // 更新同一份文件：必须先删、再传，且不能留下副本。
  const second = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 2, extra: 'x'.repeat(20) }))
  server.calls.length = 0
  await transport.writeReplica('device-a.json', second)
  const order = server.calls.filter(call => call.method === 'filemanager' || call.method === 'precreate').map(call => call.method)
  check('更新时先删后传', order[0] === 'filemanager' && order.includes('precreate'), JSON.stringify(order))
  check('更新后仍只有一个文件', replicas(server).length === 1, replicas(server).join(','))
  check('目录里没有 (1) 副本', replicas(server).every(path => !path.includes('(1)')), replicas(server).join(','))

  const readBack = await transport.readReplica('device-a.json')
  check('读回的是新内容', readBack !== null && readBack.equals(second), readBack === null ? 'null' : `${readBack.length} 字节`)
}

/* ------------------------------------------------------ 读取不缓存 fs_id */
section('读取：每次重新解析，不缓存 fs_id')
{
  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl })
  await transport.ensureDirs()
  await transport.writeReplica('device-a.json', Buffer.from('{"revision":1}'))
  const firstRead = await transport.readReplica('device-a.json')

  // 关键场景：覆盖写换了 fs_id；若实现缓存了第一次的 fs_id，这里就会读到旧内容。
  await transport.writeReplica('device-a.json', Buffer.from('{"revision":2}'))
  server.calls.length = 0
  const secondRead = await transport.readReplica('device-a.json')
  const lists = server.calls.filter(call => call.method === 'list')
  check('读之前重新列了目录', lists.length === 1, `列了 ${lists.length} 次`)
  check('读到新内容而不是过期内容', secondRead?.toString('utf8') === '{"revision":2}', secondRead?.toString('utf8'))
  check('两次读取结果不同', firstRead?.toString('utf8') !== secondRead?.toString('utf8'))

  const missing = await transport.readReplica('nobody.json')
  check('副本不存在返回 null', missing === null, String(missing))
}

/* ------------------------------------------------- 模拟网盘改写目标路径 */
section('防护：网盘若改写目标路径就报错')
{
  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl, retries: 0 })
  await transport.ensureDirs()
  await transport.writeReplica('device-a.json', Buffer.from('{"revision":1}'))
  // 打补丁：让 create 无视 rtype 一律返回 (1) 路径，模拟覆盖语义失效。
  const original = server.fetchImpl
  const patched = async (url, init) => {
    const response = await original(url, init)
    const isCreate = String(url).includes('method=create') && init?.body instanceof URLSearchParams
    if (!isCreate) return response
    const form = Object.fromEntries(init.body)
    if (form.isdir === '1') return response // 建目录走同一个 method，别碰
    // clone 后再读：直接读会把原响应的 body 消费掉，返回回去就炸。
    const body = JSON.parse(await response.clone().text())
    if (body.path && !body.path.includes('(1)')) {
      body.path = `${body.path}(1)`
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return response
  }
  const guarded = createBaiduTransport({ token: TOKEN, fetchImpl: patched, retries: 0 })
  await guarded.ensureDirs()
  let caught = null
  try {
    await guarded.writeReplica('device-a.json', Buffer.from('{"revision":9}'))
  } catch (error) {
    caught = error
  }
  check('路径被改写时抛错', caught instanceof BaiduError, String(caught))
  check('错误信息说明了原因', String(caught?.message).includes('改写'), caught?.message)
}

/* ---------------------------------------------------------- 分片无 errno */
section('分片上传：errno 缺失视为成功')
{
  const server = makeServer({ superfile2WithoutErrno: true })
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl, retries: 0 })
  await transport.ensureDirs()
  let ok = true
  try {
    await transport.writeReplica('device-a.json', Buffer.from('{"branch":"no-errno"}'))
  } catch (error) {
    ok = false
    check('分片无 errno 时不报错', false, error?.message)
  }
  if (ok) check('分片无 errno 时不报错', true)
  const readBack = await transport.readReplica('device-a.json')
  check('内容按分片返回的 md5 落盘', readBack?.toString('utf8') === '{"branch":"no-errno"}', readBack?.toString('utf8'))
}

/* ----------------------------------------------------------- 大小与完整性 */
section('大小上限与完整性校验')
{
  // 先确认那个不可信的 md5 完全不影响读取：这是真实链路验收踩出来的坑，
  // 当时把它当内容 md5 校验，导致每一次正常下载都被判成损坏。
  const bogusServer = makeServer()
  const bogusTransport = createBaiduTransport({ token: TOKEN, fetchImpl: bogusServer.fetchImpl, retries: 0 })
  await bogusTransport.ensureDirs()
  const payload = Buffer.from('{"revision":"md5-is-not-content-md5"}')
  await bogusTransport.writeReplica('device-a.json', payload)
  const listed = await bogusTransport.listReplicas()
  check('列目录确实返回的是那个非十六进制签名', listed[0]?.md5 === BOGUS_MD5, String(listed[0]?.md5))
  const readBack = await bogusTransport.readReplica('device-a.json')
  check('该签名不可信时仍能正常读取', readBack !== null && readBack.equals(payload), readBack?.toString('utf8'))

  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl, retries: 0 })
  await transport.ensureDirs()
  let oversize = null
  try {
    await transport.writeReplica('big.json', Buffer.alloc(MAX_REMOTE_BYTES + 1))
  } catch (error) {
    oversize = error
  }
  check('拒绝写入超过 1 MiB 的内容', oversize instanceof BaiduError, String(oversize))

  const truncated = makeServer({ truncateDownload: true })
  const truncatedTransport = createBaiduTransport({ token: TOKEN, fetchImpl: truncated.fetchImpl, retries: 0 })
  await truncatedTransport.ensureDirs()
  await truncatedTransport.writeReplica('device-a.json', Buffer.from('{"revision":1}'))
  let mismatch = null
  try {
    await truncatedTransport.readReplica('device-a.json')
  } catch (error) {
    mismatch = error
  }
  check('下载被截断时报错', mismatch instanceof BaiduError && String(mismatch.message).includes('字节数'), String(mismatch))
}

/* -------------------------------------------------------------- 删除幂等 */
section('删除：幂等')
{
  const server = makeServer()
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl })
  await transport.ensureDirs()
  await transport.writeReplica('device-a.json', Buffer.from('{"revision":1}'))
  const first = await transport.deleteReplica('device-a.json')
  const second = await transport.deleteReplica('device-a.json')
  check('第一次删除成功', first.removed === true)
  check('删不存在的副本不报错', second.removed === false)
  check('删除后列表为空', (await transport.listReplicas()).length === 0)
}

/* ---------------------------------------------------------------- 重试 */
section('重试：只对可重试错误退避')
{
  const server = makeServer({ failFirst: 2 })
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl, retries: 3 })
  let ok = true
  try {
    await transport.ensureDirs()
  } catch (error) {
    ok = false
    check('5xx 后自动重试成功', false, error?.message)
  }
  if (ok) check('5xx 后自动重试成功', true)
}

/* ------------------------------------------------------------ token 安全 */
section('token 安全：不进 URL 之外的地方')
{
  const server = makeServer({ dlinkWithoutToken: true })
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl, retries: 0 })
  await transport.ensureDirs()
  await transport.writeReplica('device-a.json', Buffer.from('{"revision":1}'))
  await transport.readReplica('device-a.json')
  const download = server.calls.find(call => call.host === 'd.pcs.baidu.com')
  check('下载自动补上 access_token', download?.hasToken === true)
  check('所有请求都自带 token', server.calls.every(call => call.hasToken))

  // 错误信息里绝不能出现 token。
  const failing = createBaiduTransport({
    token: TOKEN,
    retries: 0,
    fetchImpl: async () => { throw new Error(`connect failed for https://pan.baidu.com/x?access_token=${TOKEN}`) },
  })
  let leaked = null
  try {
    await failing.ensureDirs()
  } catch (error) {
    leaked = error
  }
  check('错误信息不含 token', leaked !== null && !String(leaked.message).includes(TOKEN), leaked?.message)
  check('错误信息含脱敏标记', String(leaked?.message).includes('***'), leaked?.message)
}

/* ------------------------------------------------------------ 测试读写探针 */
section('测试读写探针（设置页的「测试读写」）')
{
  const server = makeServer({})
  const transport = createBaiduTransport({ token: TOKEN, fetchImpl: server.fetchImpl })
  const result = await transport.probe()
  check('探针成功', result.ok === true, JSON.stringify(result))
  check('写进去的字节数 > 0', result.bytes > 0, String(result.bytes))
  check('逐字节读回一致', result.readBack === true)
  check('探针文件被删掉了（不留垃圾）', result.removed === true)
  check('成功时没有错误信息', result.error === null, String(result.error))
  check('报告了实际目录', typeof result.dir === 'string' && result.dir.startsWith('/'), String(result.dir))

  const again = await transport.probe()
  check('连测两次都成功（名字不撞）', again.ok === true && again.removed === true, JSON.stringify(again))

  // 截断的读回必须判为失败：能读到但内容不对，比读不到更危险。
  const truncated = makeServer({ truncateDownload: true })
  const corrupted = await createBaiduTransport({ token: TOKEN, fetchImpl: truncated.fetchImpl, retries: 0 }).probe()
  check('读回被截断时判失败', corrupted.ok === false, JSON.stringify(corrupted))
  check('并且给出可读原因', corrupted.readBack === false && typeof corrupted.error === 'string' && corrupted.error !== '', String(corrupted.error))
  check('失败时仍然清理探针文件', corrupted.removed === true, JSON.stringify(corrupted))
}

/* ---------------------------------------------------------------- 目录迁移 */
section('云端目录迁移')
{
  const DEFAULT_DIR = '/dsh-history-plugin'
  const MIGRATED = '/我的应用数据/插件历史'
  const migratedReplicas = `${MIGRATED}/v1/replicas`

  /** 假网盘上的一个 transport；ignorePointer 用来「只看某个目录」而不理会指针。 */
  const make = (server, remoteDir, ignorePointer) => createBaiduTransport({
    token: TOKEN,
    fetchImpl: server.fetchImpl,
    ...(remoteDir === undefined ? {} : { remoteDir }),
    ...(ignorePointer === true ? { ignorePointer: true } : {}),
    retries: 0,
  })

  const server = makeServer({})
  const migrator = createMigrator({
    createTransport: (options = {}) => make(server, options.remoteDir, options.ignorePointer),
  })

  // 先在默认目录里放两份副本（同时会写下固定位置的目录指针）。
  const origin = make(server)
  await origin.writeReplica('device-a.json', Buffer.from('{"deviceId":"a","entries":[]}', 'utf8'))
  await origin.writeReplica('device-b.json', Buffer.from('{"deviceId":"b","entries":[]}', 'utf8'))
  check('准备：默认目录里有 2 份副本', (await origin.listReplicas()).length === 2)
  check('准备：指针指向默认副本目录', (await origin.readLocation())?.replicasDir === `${DEFAULT_DIR}/v1/replicas`,
    JSON.stringify(await origin.readLocation()?.replicasDir))

  // 校验函数本身
  check('校验：相对路径被拒', validateRemoteDir('relative/dir').ok === false)
  check('校验：穿越被拒', validateRemoteDir('/a/../b').ok === false)
  check('校验：根目录被拒', validateRemoteDir('/').ok === false)
  check('校验：合法目录通过并去掉尾斜杠', validateRemoteDir('/a/b///').dir === '/a/b')

  const moved = await migrator.run({ to: `${MIGRATED}/` })
  check('迁移成功', moved.status === MIGRATE_STATUS.moved, JSON.stringify(moved).slice(0, 200))
  check('复制并核对了两份', moved.copied === 2 && moved.verified === 2, `${moved.copied}/${moved.verified}`)
  check('报告了新副本目录', moved.replicasDir === migratedReplicas, String(moved.replicasDir))
  check('旧目录默认不删（须单独确认）', moved.cleanup?.pending === true && moved.cleanup?.removedFiles === 0, JSON.stringify(moved.cleanup))

  // 关键：搬完之后，指针必须指向新目录——这是别的设备唯一的发现入口。
  const pointer = await origin.readLocation()
  check('固定位置的指针已指向新副本目录', pointer?.replicasDir === migratedReplicas, JSON.stringify(pointer))
  check('指针记下了迁移来源', pointer?.migratedFrom === DEFAULT_DIR, String(pointer?.migratedFrom))

  // 新设备（默认配置、什么都没配）应当自己找到搬走的目录。
  const newcomer = make(server)
  await newcomer.ensureDirs()
  check('新设备通过指针解析到新目录', newcomer.replicasDir === migratedReplicas, newcomer.replicasDir)
  const visible = await newcomer.listReplicas()
  check('新设备看到了两份副本', visible.length === 2, visible.map(item => item.name).join(','))
  const one = await newcomer.readReplica('device-a.json')
  check('新设备读到的内容逐字节一致', one !== null && one.toString('utf8') === '{"deviceId":"a","entries":[]}', String(one))

  // 反过来证明数据**真的在新目录里**，而不是被写回了旧目录（目标 transport 忘加
  // ignorePointer 时就会这样，而且核对还会通过）。
  const oldDirOnly = make(server, DEFAULT_DIR, true)
  await oldDirOnly.ensureDirs()
  check('旧副本目录里仍留着旧的两份（未删）', (await oldDirOnly.listReplicas()).length === 2)
  const newDirOnly = make(server, MIGRATED, true)
  await newDirOnly.ensureDirs()
  check('新副本目录里确实有这两份', (await newDirOnly.listReplicas()).length === 2)

  const again = await migrator.run({ to: MIGRATED })
  check('目标就是当前目录时什么都不做', again.status === MIGRATE_STATUS.sameDir, JSON.stringify(again).slice(0, 160))

  const bad = await migrator.run({ to: '/../etc' })
  check('非法目录在动手前被拒', bad.status === MIGRATE_STATUS.refused && bad.reason === 'invalid-dir', JSON.stringify(bad).slice(0, 160))
  check('被拒后指针没被改动', (await origin.readLocation())?.replicasDir === migratedReplicas)

  // 目标目录不可写：探针会失败，于是必须在改动任何东西之前就返回。
  const brokenServer = makeServer({ truncateDownload: true })
  const brokenMigrator = createMigrator({ createTransport: (options = {}) => make(brokenServer, options.remoteDir, options.ignorePointer) })
  const refused = await brokenMigrator.run({ to: '/unwritable' })
  check('目标目录不可写时拒绝迁移', refused.status === MIGRATE_STATUS.refused && refused.reason === 'target-unwritable', JSON.stringify(refused).slice(0, 200))
  check('拒绝时给出了可读原因', typeof refused.error === 'string' && refused.error !== '', String(refused.error))

  // 第二次明确要求才清理旧目录
  const second = await migrator.run({ to: '/second-dir', removeOld: true })
  check('第二次迁移成功', second.status === MIGRATE_STATUS.moved, JSON.stringify(second).slice(0, 160))
  check('这次清理了旧副本文件', second.cleanup?.removedFiles === 2, JSON.stringify(second.cleanup))
  check('空出来的旧目录也删掉了', second.cleanup?.dirRemoved === true, JSON.stringify(second.cleanup))
  const migratedGone = make(server, MIGRATED, true)
  await migratedGone.ensureDirs()
  check('被清理的目录里没有副本了', (await migratedGone.listReplicas()).length === 0)
  const secondOnly = make(server, '/second-dir', true)
  await secondOnly.ensureDirs()
  check('最新目录里有这两份', (await secondOnly.listReplicas()).length === 2)
  check('指针指向最新目录', (await origin.readLocation())?.replicasDir === '/second-dir/v1/replicas')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
