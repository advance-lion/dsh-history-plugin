/**
 * 同步编排：把本机账本推到网盘、把各设备的副本拉回来合并成一份历史。
 *
 * 设计要点，每一条都有理由：
 *
 *  - **每台设备只写自己那一份 `<deviceId>.json`。** 网盘没有本功能可用的原子
 *    比较写入，多设备共写一个文件必然互相覆盖、丢历史。各写各的，读取时合并。
 *  - **远端文件全部按不可信输入校验。** 校验不过的文件被跳过并记警告，
 *    绝不让一个坏文件毁掉整次同步，也绝不拿它覆盖本机的好数据。
 *  - **本地缓存按网盘账号 `uk` 隔离。** 同一台电脑换一个网盘账号时，上一个账号
 *    的远端视图必须整体丢弃，否则两个账号的历史会混在一起。
 *  - **推送防抖、失败退避。** 安装是低频动作，但一次安装会触发多个事件；
 *    合并成一次推送，失败后按指数退避重试，且不阻塞采集。
 *  - **超过 1 MiB 时按「最新的留下」截断，并显式记下截断条数**（写进文档的
 *    `truncated` 字段），而不是静默丢历史。
 */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { createBaiduTransport } from './baidu.js'
import {
  MAX_REMOTE_BYTES,
  buildUploadDocument,
  digest,
  loadHistory,
  timestampOf,
  validateRemoteDocument,
} from './store.js'
import { SCHEMA_VERSION, dataDir, logEvent, nowIso, readJsonFile, writeJsonAtomic } from './util.js'

/** 副本文件后缀。 */
export const REMOTE_SUFFIX = '.json'
/** 一次同步最多拉取多少台设备的副本，防止目录被别人塞满后拖垮同步。 */
export const MAX_DEVICES = 50
/** 推送防抖窗口（毫秒）。 */
export const PUSH_DEBOUNCE_MS = 5000
/** 推送失败后的基础退避（毫秒）。 */
export const PUSH_RETRY_BASE_MS = 15000
/** 单个远端文档的字节上限。与账本上限同一个数，只在这里定义一次。 */
export const MAX_DOCUMENT_BYTES = MAX_REMOTE_BYTES

/**
 * 把上传文档裁到字节上限之内，并如实记录被裁掉了多少条。
 *
 * 保留最新的条目：历史的价值随时间递减，而「最近装了什么」才是跨设备最需要的。
 * @param {object} document 上传文档。
 * @param {number} [maxBytes] 字节上限。
 * @returns {{ document: object, bytes: number, dropped: number }} 裁剪结果。
 */
export function trimToFit(document, maxBytes = MAX_DOCUMENT_BYTES) {
  const entries = Array.isArray(document.entries) ? [...document.entries] : []
  // 先按时间从新到旧，裁掉的就是最旧的那些。
  entries.sort((a, b) => (timestampOf(a) < timestampOf(b) ? 1 : -1))
  let kept = entries
  let bytes = Buffer.byteLength(JSON.stringify({ ...document, entries: kept }), 'utf8')
  while (kept.length > 1 && bytes > maxBytes) {
    // 每次砍掉最旧的 10%（至少 1 条），避免超限时逐条重算 JSON 太慢。
    const drop = Math.max(1, Math.floor(kept.length * 0.1))
    kept = kept.slice(0, kept.length - drop)
    bytes = Buffer.byteLength(JSON.stringify({ ...document, entries: kept }), 'utf8')
  }
  const dropped = entries.length - kept.length
  const trimmed = { ...document, entries: kept }
  if (dropped > 0) {
    // 显式声明被截断，让别的设备能如实显示「这台设备更早的历史没上传」。
    trimmed.truncated = {
      dropped,
      kept: kept.length,
      note: '超出单份文件 1 MiB 上限，仅保留较新的记录',
    }
  }
  return { document: trimmed, bytes, dropped }
}

/**
 * 合并若干份文档（本机 + 各远端设备）成一份跨设备历史。
 *
 * 跨设备匹配靠归一化 `key`：同一个插件用 registry / git / tarball 装在不同机器上，
 * key 相同才算同一个插件，否则界面上会出现重复条目。
 *
 * @param {object[]} documents 文档列表。
 * @param {Map<string, string|null>} [current] 本机当前已安装的 包名→版本。
 * @returns {{ rows: object[], devices: object[], entries: number }} 合并结果。
 */
export function mergeDocuments(documents, current = new Map()) {
  /** @type {Map<string, object>} */
  const byKey = new Map()
  /** @type {Map<string, object>} */
  const devices = new Map()
  let total = 0

  for (const document of documents) {
    if (document === null || typeof document !== 'object') continue
    if (!Array.isArray(document.entries)) continue
    const deviceId = typeof document.deviceId === 'string' && document.deviceId !== '' ? document.deviceId : 'unknown'
    const label = typeof document.deviceLabel === 'string' && document.deviceLabel !== '' ? document.deviceLabel : null
    const device = devices.get(deviceId) ?? { deviceId, label: null, lastAt: null, entries: 0 }
    if (label !== null) device.label = label

    for (const entry of document.entries) {
      if (entry === null || typeof entry !== 'object') continue
      const at = timestampOf(entry)
      if (device.lastAt === null || at > device.lastAt) device.lastAt = at
      device.entries += 1
      total += 1

      const key = typeof entry.key === 'string' ? entry.key : `${entry.packageName}@${entry.version ?? ''}`
      let row = byKey.get(key)
      if (row === undefined) {
        row = { key, packageName: entry.packageName, entries: [], perDevice: new Map() }
        byKey.set(key, row)
      }
      row.entries.push(entry)
      const seen = row.perDevice.get(deviceId)
      if (seen === undefined || at > seen.at) {
        row.perDevice.set(deviceId, { deviceId, at, kind: entry.kind, version: entry.version ?? null })
      }
    }
    // 只登记真正有记录的设备：一份空文档（新机器还没装过任何插件）不该被算成
    // 「一台设备」，否则新机器一拉取就谎报设备数。本机也一样，没装过就是 0 台。
    if (device.entries > 0) devices.set(deviceId, device)
  }

  const rows = []
  for (const row of byKey.values()) {
    const entries = [...row.entries].sort((a, b) => (timestampOf(a) < timestampOf(b) ? 1 : -1))
    const versions = []
    for (const entry of entries) {
      const version = entry.version ?? null
      if (version !== null && !versions.includes(version)) versions.push(version)
    }
    // 重装目标取「最新的、且确实可重装」的那条 spec。
    const target = entries.find(entry => entry.installSpec !== null && entry.installSpec !== undefined && entry.reinstallable !== false) ?? null
    const deviceList = [...row.perDevice.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    rows.push({
      key: row.key,
      packageName: row.packageName,
      entries,
      entryCount: entries.length,
      versions,
      latestAt: entries.length === 0 ? null : timestampOf(entries[0]),
      latest: entries[0] ?? null,
      /** 最近一次「确证安装」（区别于仅被扫描发现）。 */
      lastInstalledAt: entries.find(entry => entry.kind === 'installed') === undefined
        ? null
        : timestampOf(entries.find(entry => entry.kind === 'installed')),
      devices: deviceList,
      deviceCount: deviceList.length,
      installSpec: target === null ? null : target.installSpec,
      sourceType: target === null ? (entries[0]?.sourceType ?? null) : target.sourceType,
      reinstallable: target !== null,
      /** 本机现在是否装着。装过了就不提示重装，这是界面上最有用的一列。 */
      present: current.has(row.packageName),
      presentVersion: current.get(row.packageName) ?? null,
    })
  }
  rows.sort((a, b) => String(b.latestAt ?? '').localeCompare(String(a.latestAt ?? '')))

  const deviceList = [...devices.values()].sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
  return { rows, devices: deviceList, entries: total }
}

/**
 * 内容摘要：只看条目本身，按事件 id 排序后再算。
 *
 * **不能直接摘要整份文档。** 上传文档里有 `updatedAt: nowIso()`，每次生成都不同，
 * 拿整份文档做摘要会让「无变化就跳过推送」永远不成立——每次防抖都会白传一次，
 * 界面也会永远显示「有未同步的变化」。
 *
 * 排序是为了让摘要与条目的排列顺序无关：本地顺序与排序后顺序不该被当成内容变化。
 *
 * @param {unknown} entries 条目数组。
 * @returns {string} 摘要。
 */
export function contentDigest(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => entry !== null && typeof entry === 'object')
  const sorted = [...list].sort((a, b) => String(a.eventId ?? '').localeCompare(String(b.eventId ?? '')))
  return digest(sorted)
}

/**
 * 建立同步器。
 *
 * @param {{
 *   getGrant: () => Promise<{ grant: object, source: string }|null>,
 *   getDevice: () => { deviceId: string, deviceLabel?: string|null },
 *   getCurrent: () => Map<string, string|null>,
 *   config: { remoteDir?: string, autoSync?: boolean },
 *   onWarn?: (message: string) => void,
 *   onChanged?: () => void,
 *   transportFactory?: (options: object) => object,
 * }} options 依赖与配置。
 * @returns {object} 同步器。
 */
export function createSync(options) {
  const onWarn = options.onWarn ?? (() => {})
  const onChanged = options.onChanged ?? (() => {})
  const remoteDir = options.config?.remoteDir
  const autoSync = options.config?.autoSync !== false
  // 传输层可注入：测试要能在不碰真实网盘的前提下验证编排逻辑。
  const transportFactory = options.transportFactory ?? createBaiduTransport

  /** 内存里的远端文档：deviceId → 文档。 */
  let remoteDocuments = new Map()
  /** 当前缓存所属的网盘账号。 */
  let cachedUk = null
  /** 最近一次成功推送的文档摘要，用来跳过无变化的推送。 */
  let lastPushedDigest = null
  let lastPullAt = null
  let lastPushAt = null
  let lastError = null
  let disposed = false
  let pushTimer = null
  let pushFailures = 0
  let running = Promise.resolve()

  const cacheFile = uk => join(dataDir(), 'accounts', String(uk ?? 'unknown'), 'remote.json')

  /** 读回上次的远端缓存。 */
  function loadCache(uk) {
    const raw = readJsonFile(cacheFile(uk), null)
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.documents)) return null
    return raw
  }

  /**
   * 把远端缓存落到磁盘。
   * 缓存按账号分目录，换账号时天然读不到上一个账号的数据。
   */
  function saveCache(uk, documents) {
    writeJsonAtomic(cacheFile(uk), {
      schemaVersion: SCHEMA_VERSION,
      uk,
      remoteDir: remoteDir ?? null,
      fetchedAt: nowIso(),
      documents,
    })
  }

  /**
   * 建传输器。没有授权就返回 null，让调用方走「未配置」分支而不是抛错。
   * @returns {Promise<{ transport: object, grant: object, source: string }|null>} 传输器。
   */
  async function connect() {
    const stored = await options.getGrant()
    if (stored === null || stored.grant === null) return null
    const transport = transportFactory({
      token: stored.grant.accessToken,
      remoteDir,
      schemaVersion: SCHEMA_VERSION,
      onWarn,
    })
    return { transport, grant: stored.grant, source: stored.source }
  }

  /** 串行化所有网络动作：网盘对并发并不友好，而且并发写同一份文件毫无意义。 */
  function enqueue(operation) {
    const next = running.then(operation, operation)
    // 吞掉异常，避免一次失败让后续操作全部短路。
    running = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 动手前先确认授权可用。
   *
   * 授权快过期时由上层去刷新（刷新的细节属于 OAuth 层，同步层不该知道）。
   * 只有「已过期且刷不出来」才拦下操作并给出可操作的原因；其它刷新失败都只是
   * 告警后继续用当前 token——多一次成功同步比多一次误报有用。
   * @returns {Promise<object|null>} 要直接返回的失败结果，或 null 表示可以继续。
   */
  async function prepare() {
    if (typeof options.refreshTokens !== 'function') return null
    let outcome = null
    try {
      outcome = await options.refreshTokens()
    } catch (error) {
      onWarn(`刷新授权时出错，继续沿用当前 token：${error?.message ?? error}`)
      return null
    }
    if (outcome === null || outcome?.ok === true) return null
    if (outcome.expired === true) {
      const message = outcome.message ?? '授权已过期，请重新授权'
      lastError = message
      return { ok: false, reason: 'token-expired', error: message }
    }
    return null
  }

  /**
   * 拉取所有设备的副本并合并。
   * @param {{ force?: boolean }} [params] 选项。
   * @returns {Promise<object>} 拉取结果。
   */
  function pull(params = {}) {
    return enqueue(async () => {
      if (disposed) return { ok: false, reason: 'disposed' }
      const blocked = await prepare()
      if (blocked !== null) return blocked
      const connection = await connect()
      if (connection === null) {
        lastError = null
        return { ok: false, reason: 'unconfigured' }
      }
      try {
        const account = await connection.transport.getAccount()
        // 账号变了：整体丢弃上一个账号的缓存，避免两个账号的历史混在一起。
        if (cachedUk !== null && account.uk !== null && cachedUk !== account.uk) {
          logEvent('info', 'sync-account-changed', `uk ${cachedUk} → ${account.uk}，丢弃本地远端缓存`)
          remoteDocuments = new Map()
          lastPushedDigest = null
        }
        cachedUk = account.uk
        if (!params.force && remoteDocuments.size === 0) {
          const cached = account.uk === null ? null : loadCache(account.uk)
          if (cached !== null) {
            remoteDocuments = new Map(cached.documents.map(document => [document.deviceId, document]))
          }
        }

        const listed = await connection.transport.listReplicas()
        const files = listed
          .filter(item => item.name.endsWith(REMOTE_SUFFIX))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, MAX_DEVICES)

        const deviceId = options.getDevice().deviceId
        const documents = []
        const skipped = []
        for (const file of files) {
          const wanted = file.name.slice(0, -REMOTE_SUFFIX.length)
          try {
            const buffer = await connection.transport.readReplica(file.name)
            if (buffer === null) {
              skipped.push({ name: file.name, reason: 'not-found' })
              continue
            }
            let parsed
            try {
              parsed = JSON.parse(buffer.toString('utf8'))
            } catch {
              skipped.push({ name: file.name, reason: 'invalid-json' })
              continue
            }
            // 远端是不可信输入：schema、设备一致性、字段长度全都要过。
            const document = validateRemoteDocument(parsed)
            if (document === null) {
              skipped.push({ name: file.name, reason: 'invalid-schema' })
              continue
            }
            if (document.deviceId !== wanted) {
              skipped.push({ name: file.name, reason: 'device-mismatch' })
              continue
            }
            documents.push(document)
            // 自己那份也放进来：本机账本可能比云上更新，合并时按事件去重即可。
            if (document.deviceId === deviceId) lastPushedDigest = contentDigest(document.entries)
          } catch (error) {
            skipped.push({ name: file.name, reason: error?.message ?? String(error) })
          }
        }

        remoteDocuments = new Map(documents.map(document => [document.deviceId, document]))
        if (cachedUk !== null) saveCache(cachedUk, documents)
        lastPullAt = nowIso()
        lastError = null
        if (skipped.length > 0) {
          onWarn(`${skipped.length} 份远端文件被跳过：${skipped.map(item => `${item.name}(${item.reason})`).join('、')}`)
        }
        onChanged()
        const merged = mergedView()
        logEvent('info', 'sync-pull', `uk=${cachedUk ?? '-'} 文件 ${files.length}，合并 ${merged.entries} 条 / ${merged.rows.length} 个插件`)
        return { ok: true, ...merged, fetchedAt: lastPullAt, skipped }
      } catch (error) {
        lastError = error?.message ?? String(error)
        logEvent('warn', 'sync-pull-failed', lastError)
        return { ok: false, reason: 'failed', error: lastError }
      }
    })
  }

  /**
   * 推送本机账本。无变化时跳过（用文档摘要判断）。
   * @param {{ force?: boolean }} [params] 选项。
   * @returns {Promise<object>} 推送结果。
   */
  function push(params = {}) {
    return enqueue(async () => {
      if (disposed) return { ok: false, reason: 'disposed' }
      const blocked = await prepare()
      if (blocked !== null) return blocked
      const connection = await connect()
      if (connection === null) return { ok: false, reason: 'unconfigured' }
      try {
        const device = options.getDevice()
        const document = buildUploadDocument(device.deviceLabel ?? null)
        const summary = contentDigest(document.entries)
        if (!params.force && summary === lastPushedDigest) {
          return { ok: true, skipped: 'unchanged', bytes: 0 }
        }
        const trimmed = trimToFit(document)
        const buffer = Buffer.from(JSON.stringify(trimmed.document), 'utf8')
        if (buffer.length > MAX_DOCUMENT_BYTES) {
          // 单条事件就超限属于异常，宁可失败也不要上传一份残缺文档。
          throw new Error(`本机账本单份文档超过上限（${buffer.length} 字节），已放弃推送`)
        }
        await connection.transport.writeReplica(`${device.deviceId}${REMOTE_SUFFIX}`, buffer)
        // 记的是**裁剪前**的本地内容摘要：因为上限裁掉的条目不是用户能改变的东西，
        // 若改记裁剪后的摘要，每次防抖都会认为「又变了」而重复上传同一份内容。
        lastPushedDigest = summary
        lastPushAt = nowIso()
        lastError = null
        pushFailures = 0
        onChanged()
        logEvent('info', 'sync-push', `设备=${device.deviceId} 事件 ${trimmed.document.entries.length} 条，${buffer.length} 字节${trimmed.dropped > 0 ? `（截断 ${trimmed.dropped} 条）` : ''}`)
        return { ok: true, bytes: buffer.length, entries: trimmed.document.entries.length, dropped: trimmed.dropped }
      } catch (error) {
        lastError = error?.message ?? String(error)
        pushFailures += 1
        logEvent('warn', 'sync-push-failed', lastError)
        return { ok: false, reason: 'failed', error: lastError }
      }
    })
  }

  /** 本机 + 各远端的合并视图。 */
  function mergedView() {
    const local = loadHistory()
    const device = options.getDevice()
    const localDocument = {
      deviceId: device.deviceId,
      deviceLabel: device.deviceLabel ?? null,
      updatedAt: local.updatedAt,
      entries: local.entries,
    }
    const others = [...remoteDocuments.values()].filter(document => document.deviceId !== device.deviceId)
    return mergeDocuments([localDocument, ...others], options.getCurrent())
  }

  /**
   * 安排一次推送（防抖）。安装会连发多个事件，合并成一次推送。
   * @param {string} reason 触发原因，仅用于日志。
   * @returns {void}
   */
  function schedule(reason) {
    if (disposed || !autoSync) return
    if (pushTimer !== null) clearTimeout(pushTimer)
    // 连续失败时按次数退避，避免网盘不可用时不停地打。
    const delay = PUSH_DEBOUNCE_MS * (pushFailures === 0 ? 1 : Math.min(8, 2 ** pushFailures))
    pushTimer = setTimeout(() => {
      pushTimer = null
      void push().then(result => {
        if (result.ok === false && result.reason === 'failed' && pushFailures < 4) schedule(`retry-${reason}`)
      })
    }, delay)
    // 别让这个定时器拖住进程退出。
    if (typeof pushTimer.unref === 'function') pushTimer.unref()
  }

  return {
    pull,
    push,
    /** 先拉后推：界面先看到别的设备，再把本机的推上去。 */
    async sync(params = {}) {
      const pulled = await pull(params)
      const pushed = await push(params)
      return { pulled, pushed }
    },
    schedule,
    mergedView,
    /**
     * 对界面安全的状态。**绝不包含 token**。
     * @returns {object} 状态。
     */
    status() {
      const merged = mergedView()
      return {
        configured: cachedUk !== null || remoteDocuments.size > 0,
        remoteDir: remoteDir ?? null,
        accountUk: cachedUk,
        autoSync,
        lastPullAt,
        lastPushAt,
        lastError,
        pendingPush: pushTimer !== null,
        deviceCount: merged.devices.length,
        devices: merged.devices,
        pluginCount: merged.rows.length,
        entryCount: merged.entries,
      }
    },
    /** 测试与排障：直接看当前内存中的远端文档。 */
    documents() {
      return [...remoteDocuments.values()]
    },
    /** 是否有未推送的本地变化。 */
    hasPendingChanges() {
      return contentDigest(buildUploadDocument(options.getDevice().deviceLabel ?? null).entries) !== lastPushedDigest
    },
    dispose() {
      disposed = true
      if (pushTimer !== null) {
        clearTimeout(pushTimer)
        pushTimer = null
      }
      remoteDocuments = new Map()
    },
  }
}
