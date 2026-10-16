/**
 * dsh-history-plugin · 安装事件采集（宿主半边）
 *
 * 三件事，按可信度从高到低：
 *
 *   1) **实时**：`plugin-manager/changed` 只是一个信号（载荷只有 `{reason}`），
 *      事件到达后回读 `listBundles()` 与 profile 的 `package.json` 做 diff。
 *   2) **补录**：启动时扫一次现存的外部 bundle。历史里有、但上次快照没有 → 重装；
 *      历史里完全没有 → 首见（`discovered`，只有 `observedAt`，绝不伪称安装日期）。
 *   3) **升级可信度**：市场自己的 `.dsh-market/log.ndjson` 里 `install` 事件带
 *      真实时间戳与精确 spec。凡是被它覆盖的包，一律用它的事件（真实安装时间），
 *      不再退化成 `discovered`。
 *
 * 过滤规则（`isRecordableBundle`）是整个采集层的核心，依据 `listBundles()` 的字段语义：
 *   - `installed` = 该包在 profile 的 `dependencies` 里（真正装过；仅启用不算）
 *   - `removable` = 不是 DSH installation 自带的包（天然排除预装与官方 bundle）
 * 所以 `installed && removable` 正好等于「用户自己装进来的外部 bundle」。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KIND_DISCOVERED,
  KIND_INSTALLED,
  PROVENANCE,
  appendEntries,
  buildEntry,
  deviceId,
  knownPackages,
  loadHistory,
  marketEventId,
  normalizeSource,
  scanEventId,
} from './store.js'
import { dataFile, dshHome, isIsoTimestamp, logEvent, nowIso, readJsonFile, writeJsonAtomic } from './util.js'
import { PLUGIN_ID } from './util.js'

/** 市场事件日志（dshmarket 写的 NDJSON）。 */
const MARKET_LOG = join('.dsh-market', 'log.ndjson')

/** 快照 / 初始化标记的落盘文件。 */
const STATE_FILE = 'state.json'

/** 版本号用了无效值时的占位。 */
const VERSION_UNKNOWN = 'unknown'

/**
 * 该 bundle 是否值得记进历史。
 * @param {Record<string, unknown>} bundle `listBundles()` 的一项。
 * @returns {boolean} 判定结果。
 */
export function isRecordableBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object') return false
  const name = bundle.name
  if (typeof name !== 'string' || name === '' || name === PLUGIN_ID) return false
  // 只记真正装进来的：仅被启用（enabled）但不在 dependencies 里的官方项不算安装。
  if (bundle.installed !== true) return false
  // installation 自带的包（官方 / 预装）不可移除，不属于「用户下载过的插件」。
  if (bundle.removable !== true) return false
  return true
}

/**
 * 解析 profile 目录。
 *
 * 三个来源依次尝试：launcher 发布的 `profileContext`（最权威）、环境变量、
 * 默认位置。任何一层拿到就用，拿不到就放弃补录（记账仍可工作）。
 * @param {{ get: (name: string) => unknown }} ctx 宿主上下文。
 * @returns {string|null} profile 目录，或 null。
 */
export function resolveProfileDir(ctx) {
  try {
    const fromService = ctx.get('profileContext')
    if (fromService !== null && typeof fromService === 'object') {
      const dir = /** @type {Record<string, unknown>} */ (fromService).dir
      if (typeof dir === 'string' && dir.trim() !== '') return dir.trim()
    }
  } catch {
    /* 服务不存在或形态不符，继续往下试 */
  }
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const profileName = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : null
  if (profileName !== null) return join(dshHome(), 'profiles', profileName)
  return null
}

/**
 * 读 profile 的 `package.json`。
 * @param {string|null} profileDir profile 目录。
 * @returns {{ dependencies: Record<string, string> } } 只关心依赖表。
 */
export function readProfileManifest(profileDir) {
  if (profileDir === null) return { dependencies: {} }
  const raw = readJsonFile(join(profileDir, 'package.json'), null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { dependencies: {} }
  const deps = /** @type {Record<string, unknown>} */ (raw).dependencies
  /** @type {Record<string, string>} */
  const dependencies = {}
  if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
    for (const [name, value] of Object.entries(deps)) {
      if (typeof value === 'string') dependencies[name] = value
    }
  }
  return { dependencies }
}

/**
 * 把 `package.json` 里的依赖值（安装 spec）与已装版本合成归一化来源。
 * @param {string} name 包名。
 * @param {string|undefined} dependency 依赖值，如 `^0.3.19` / `github:o/r#sha` / `link:C:/…`。
 * @param {string|null} version 实际安装版本（来自 `listBundles()`）。
 * @returns {{ sourceType: string, key: string, installSpec: string|null, reinstallable: boolean }} 归一化来源。
 */
export function sourceOf(name, dependency, version) {
  const concrete = version ?? VERSION_UNKNOWN
  // 依赖值是范围（`^1.2.3` / `~1.2.3` / `1.2.3` / `latest`）时，spec 用「包名@实际版本」，
  // 这样跨设备匹配到的是同一个确切版本，而不是一个会漂移的范围。
  if (dependency === undefined || /^[\^~<>=\s]|^[\d]+\.|^latest$|^\*$|^\|\|/.test(dependency)) {
    return normalizeSource({ packageName: name, version: concrete, installSpec: null })
  }
  return normalizeSource({ packageName: name, version: concrete, installSpec: dependency })
}

/**
 * 从 `listBundles()` + profile manifest 得到「当前装着的外部 bundle」。
 * @param {unknown[]} bundles `listBundles()` 结果。
 * @param {Record<string, string>} dependencies profile 依赖表。
 * @returns {Map<string, { version: string|null, source: object }>} 包名 → 当前状态。
 */
export function currentRecordable(bundles, dependencies) {
  const map = new Map()
  if (!Array.isArray(bundles)) return map
  for (const raw of bundles) {
    if (!isRecordableBundle(raw)) continue
    const bundle = /** @type {Record<string, unknown>} */ (raw)
    const name = String(bundle.name)
    const version = typeof bundle.version === 'string' && bundle.version.trim() !== '' ? bundle.version.trim() : null
    map.set(name, { version, source: sourceOf(name, dependencies[name], version) })
  }
  return map
}

/* ------------------------------------------------------- 市场日志的补录解析 */

/**
 * 解析 `.dsh-market/log.ndjson`，还原**真实安装时间**与精确 spec。
 *
 * 只认 `install` 事件里 `exit=0` 的那一行：`<spec> exit=0 hot=true`。
 * 失败（`exit=1`）不入历史 —— 历史的定义是「曾成功安装」。
 * @param {string|null} profileDir profile 目录。
 * @returns {Array<{ at: string, name: string, version: string|null, spec: string|null }>} 成功安装记录（按时间升序）。
 */
export function parseMarketLog(profileDir) {
  if (profileDir === null) return []
  let text = ''
  try {
    text = readFileSync(join(profileDir, MARKET_LOG), 'utf8')
  } catch {
    return []
  }
  /** @type {Array<{ at: string, name: string, version: string|null, spec: string|null }>} */
  const records = []
  /** @type {Map<string, string>} */
  const pinnedVersions = new Map()

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object') continue
    if (row.event !== 'install' || typeof row.detail !== 'string' || !isIsoTimestamp(row.at)) continue

    // `dsh-image-gen: pinned to the registry's latest, 0.8.6, so pnpm's …`
    const pinned = /^(.+?): pinned to the registry's latest, ([^\s,]+),/.exec(row.detail)
    if (pinned !== null) {
      pinnedVersions.set(pinned[1].trim(), pinned[2].trim())
      continue
    }

    // `<spec> exit=<code> …`
    const result = /^(.*?)\s+exit=(-?\d+)/.exec(row.detail)
    if (result === null || result[2] !== '0') continue

    const spec = result[1].trim()
    const parsed = parseSpecIdentity(spec, pinnedVersions)
    if (parsed === null) continue
    records.push({ at: row.at, ...parsed })
  }
  records.sort((a, b) => a.at.localeCompare(b.at))
  return records
}

/**
 * 从一条市场安装 spec 里取出包名与版本。
 * @param {string} spec 形如 `dsh-image-gen@0.8.6`、`@scope/x@1.0.0`、`github:o/repo#sha`。
 * @param {Map<string, string>} pinnedVersions 市场日志里的「最新版本」提示表。
 * @returns {{ name: string, version: string|null, spec: string }|null} 解析结果。
 */
function parseSpecIdentity(spec, pinnedVersions) {
  if (spec === '') return null
  // registry：`name@version` / `@scope/name@version`
  const registry = /^(@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@([^\s@]+)$/.exec(spec)
  if (registry !== null && !registry[2].includes('/')) {
    return { name: registry[1], version: registry[2], spec }
  }
  // git / tarball：包名不在 spec 里，退回仓库名；版本从「pin 提示」或其他安装事件里找。
  const git = /^(?:github:|gitlab:|bitbucket:)([^/\s]+)\/([^#\s]+)/.exec(spec)
  if (git !== null) {
    const repo = git[2].replace(/\.git$/, '')
    return { name: repo, version: pinnedVersions.get(repo) ?? null, spec }
  }
  const url = /^https?:\/\/[^\s]+$/.exec(spec)
  if (url !== null) {
    const tail = spec.split('/').filter(Boolean).pop() ?? ''
    const name = tail.replace(/\.(tgz|tar\.gz)$/, '')
    if (name === '') return null
    return { name, version: pinnedVersions.get(name) ?? null, spec }
  }
  return null
}

/**
 * 把市场日志转成可写入账本的事件（只保留当前仍未安装过的包时也照记 —— 已卸载的也属于历史）。
 * @param {string|null} profileDir profile 目录。
 * @param {string} device 本机设备 ID。
 * @returns {object[]} 已校验的事件。
 */
export function marketEntries(profileDir, device) {
  const entries = []
  for (const record of parseMarketLog(profileDir)) {
    const source = normalizeSource({ packageName: record.name, version: record.version, installSpec: record.spec })
    const entry = buildEntry(
      {
        packageName: record.name,
        version: record.version,
        source,
        kind: KIND_INSTALLED,
        at: record.at,
        provenance: PROVENANCE.marketLog,
        // 内容派生 ID：同一条市场记录被反复解析也只会入库一次（幂等）。
        // 派生函数与 store.compactEntries 共用，保证「加载时认得出、写入时对得上」。
        eventId: marketEventId({ deviceId: device, packageName: record.name, key: source.key, installedAt: record.at }),
      },
      device,
    )
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/* ---------------------------------------------------------------- 采集器 */

/**
 * 读快照状态文件。
 * @returns {{ initialized: boolean, snapshot: Record<string, string|null> }} 状态。
 */
function readState() {
  const raw = readJsonFile(dataFile(STATE_FILE), null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { initialized: false, snapshot: {} }
  }
  const value = /** @type {Record<string, unknown>} */ (raw)
  /** @type {Record<string, string|null>} */
  const snapshot = {}
  const rawSnapshot = value.snapshot
  if (rawSnapshot !== null && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)) {
    for (const [name, version] of Object.entries(rawSnapshot)) {
      snapshot[name] = typeof version === 'string' ? version : null
    }
  }
  return { initialized: value.initialized === true, snapshot }
}

/**
 * 写快照状态文件。
 * @param {{ initialized: boolean, snapshot: Record<string, string|null> }} state 状态。
 * @returns {void}
 */
function writeState(state) {
  writeJsonAtomic(dataFile(STATE_FILE), { schemaVersion: 1, updatedAt: nowIso(), ...state })
}

/**
 * 创建采集器：负责启动补录与变更核对。
 * @param {{ getManager: () => any, profileDir: string|null }} options 依赖。
 * @returns {{ start: () => Promise<object>, reconcile: (reason: string) => Promise<object>, dispose: () => void }} 采集器。
 */
export function createCollector(options) {
  const device = deviceId()
  let disposed = false
  let timer = null
  let running = Promise.resolve(/** @type {object} */ ({}))
  let lastResult = { recorded: 0, current: 0, at: null }
  /**
   * 最近一次核对得到的「本机当前可记录插件」。
   * 缓存而不是每次现读：同步合并视图是同步调用的，读盘必须在这里提前做好。
   * @type {Map<string, string|null>}
   */
  let lastCurrent = new Map()

  /**
   * 读当前可记录集合；manager 不可用时退回 null（调用方跳过本轮）。
   * @returns {Promise<{ current: Map<string, any>, dependencies: Record<string, string> }|null>} 快照。
   */
  async function snapshot() {
    const manager = options.getManager()
    if (manager === undefined || manager === null || typeof manager.listBundles !== 'function') return null
    const dependencies = readProfileManifest(options.profileDir).dependencies
    const bundles = await manager.listBundles()
    return { current: currentRecordable(bundles, dependencies), dependencies }
  }

  /**
   * 核对一次：与上次快照 diff，把新出现的记成事件。
   * @param {string} reason 触发原因（`startup` 或事件给的 reason）。
   * @returns {Promise<{ recorded: number, current: number, at: string|null }>} 本轮结果。
   */
  async function reconcile(reason) {
    if (disposed) return lastResult
    const state = readState()
    const snap = await snapshot()
    if (snap === null) {
      logEvent('warn', 'reconcile-skipped', `${reason}: plugin-manager unavailable`)
      return lastResult
    }

    const knownBefore = knownPackages()
    // 市场日志先行：它带真实安装时间，能覆盖的包就不再退化成「首见」。
    const fromMarket = marketEntries(options.profileDir, device)
    const marketNames = new Set(fromMarket.map(entry => entry.packageName))
    const marketAdded = fromMarket.length === 0 ? 0 : appendEntries(fromMarket).added

    /** @type {object[]} */
    const fresh = []
    for (const [name, info] of snap.current) {
      const previous = state.snapshot[name]
      // 上次快照里就是同一版本 → 没有任何变化，不产生事件。
      if (state.initialized && previous !== undefined && previous === info.version) continue
      // 市场日志已经给出了确证事件，不重复补录。
      if (marketNames.has(name)) continue
      const isReinstall = knownBefore.has(name) || state.initialized
      const entry = buildEntry(
        {
          packageName: name,
          version: info.version,
          // 来源必须原样透传：local 来源的 installSpec 是 null，
          // 在这里重新推导会把 local 降级成 registry。
          source: info.source,
          kind: isReinstall ? KIND_INSTALLED : KIND_DISCOVERED,
          at: nowIso(),
          provenance: PROVENANCE.profileScan,
          // 首见是一次性补录事实 → 内容派生 ID，重复扫描不会重复入库；
          // 重装/升级是一次次发生的事实 → 随机 ID，每次都要留下新事件。
          ...(isReinstall ? {} : { eventId: scanEventId({ deviceId: device, packageName: name, version: info.version }) }),
        },
        device,
      )
      if (entry !== null) fresh.push(entry)
    }
    const freshAdded = appendEntries(fresh).added

    /** @type {Record<string, string|null>} */
    const nextSnapshot = {}
    for (const [name, info] of snap.current) nextSnapshot[name] = info.version
    // 顺手喂给同步层：它要用「本机现在装了什么」标出别的设备装过、本机缺失的行。
    lastCurrent = new Map(Object.entries(nextSnapshot))
    writeState({ initialized: true, snapshot: nextSnapshot })

    lastResult = { recorded: freshAdded + marketAdded, current: snap.current.size, at: nowIso() }
    logEvent('info', 'reconcile', `${reason}: +${freshAdded} fresh, +${marketAdded} from market log, ${snap.current.size} installed`)
    return lastResult
  }

  return {
    /**
     * 启动：串行跑一次核对（内部已含市场日志补录与首见补录）。
     * @returns {Promise<object>} 结果。
     */
    start() {
      running = running.then(() => reconcile('startup')).catch(error => {
        logEvent('error', 'startup-failed', error instanceof Error ? error.message : String(error))
        return lastResult
      })
      return running
    },
    /**
     * 事件触发：防抖合并（安装一次会连发数条 `changed`）。
     * @param {string} reason 事件给的 reason。
     * @returns {Promise<object>} 结果（防抖窗口结束后才 resolve）。
     */
    reconcile(reason) {
      if (disposed) return running
      if (timer !== null) clearTimeout(timer)
      return new Promise(resolve => {
        timer = setTimeout(() => {
          timer = null
          running = running.then(() => reconcile(reason)).catch(error => {
            logEvent('error', 'reconcile-failed', error instanceof Error ? error.message : String(error))
            return lastResult
          })
          void running.then(resolve)
        }, 1200)
        // 防抖定时器不应把进程钉在事件循环里。
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
    /** 卸载：清定时器，后续 reconcile 直接返回。 */
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    /** @returns {object} 最近一次结果。 */
    getState() {
      return { ...lastResult, history: loadHistory(device).entries.length, deviceId: device }
    },
    /**
     * 本机当前可记录插件（包名 → 版本）。
     * 只读：调用方不得修改返回的 Map。
     * @returns {Map<string, string|null>} 当前集合。
     */
    currentPackages() {
      return lastCurrent
    },
  }
}
