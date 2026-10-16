/**
 * dsh-history-plugin · 本地账本（宿主半边）
 *
 * 这一层是整件事的地基，只有两个职责：
 *
 *   1) **设备身份**：首次运行生成一个随机 UUID 存本机，用户可给它取显示名。
 *      刻意不采集硬件序列号、MAC、主机名 —— 它只是「同一台机器」的关联键。
 *
 *   2) **安装事件账本**：一条成功安装 = 一个不可变事件，带安装时间与设备 ID。
 *      追加为主（append-only），按 `eventId` 去重，重装产生新事件。
 *
 * 为什么不让多台设备共写一个 `history.json`：网盘没有本功能可用的原子比较写入，
 * 两台设备同时写就会互相覆盖。所以每台设备只写自己的那份，读取时合并。
 *
 * 来源归一化（`normalizeSource`）是这里最需要小心的地方：同一个插件在 profile 里
 * 可能是 `dsh-image-gen@0.8.6`、`github:o/r#sha`、`https://…/tar.gz/sha`、
 * `link:C:/…` 四种形态，跨设备匹配必须先归一到同一个 key。
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  PLUGIN_ID,
  SCHEMA_VERSION,
  clipString,
  isIsoTimestamp,
  logEvent,
  newId,
  nowIso,
  readJsonFile,
  writeJsonAtomic,
  dataFile,
} from './util.js'

/** 一份远端历史 JSON 的体积上限（防异常文件；超过就跳过并提示）。 */
export const MAX_REMOTE_BYTES = 1024 * 1024

/** 单台设备本地账本保留的事件上限（超出丢最旧的）。 */
export const MAX_ENTRIES = 5000

/** 事件种类：真正观察到的一次安装 / 从现存配置补录的首见。 */
export const KIND_INSTALLED = 'installed'
export const KIND_DISCOVERED = 'discovered'

/** 事件的证据来源，写进文件以便 UI 区分「确证」与「补录」。 */
export const PROVENANCE = Object.freeze({
  installResult: 'install-result', // plugin-manager 成功结果（最可信）
  marketLog: 'market-log', // 市场 .dsh-market/log.ndjson 的历史记录
  profileScan: 'profile-scan', // 扫描现存 profile 得到，只有 observedAt
})

const SOURCE_TYPES = new Set(['registry', 'git', 'tarball', 'local', 'url'])
const PROVENANCE_VALUES = new Set(Object.values(PROVENANCE))
const KINDS = new Set([KIND_INSTALLED, KIND_DISCOVERED])

const GIT_HOST_PREFIX = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }

/** 会被剔除的敏感查询参数名（云文件里不允许出现凭据）。 */
const SENSITIVE_PARAM = /^(?:access_?token|token|sign|signature|authorization|auth|key|api_?key|secret|password|pwd|credential)$/i

const ID_RE = /^[A-Za-z0-9-]{8,64}$/
const NO_TRAVERSAL = /\.\./

/* ------------------------------------------------------------------ 设备身份 */

/**
 * 读取（必要时创建）本机设备记录。
 * @returns {{ schemaVersion: number, deviceId: string, deviceLabel: string|null, createdAt: string }} 设备记录。
 */
export function loadDevice() {
  const raw = readJsonFile(dataFile('device.json'), null)
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = /** @type {Record<string, unknown>} */ (raw)
    const deviceId = candidate.deviceId
    if (typeof deviceId === 'string' && ID_RE.test(deviceId)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        deviceId,
        deviceLabel: clipString(candidate.deviceLabel, 60),
        createdAt: isIsoTimestamp(candidate.createdAt) ? candidate.createdAt : nowIso(),
      }
    }
  }
  const created = { schemaVersion: SCHEMA_VERSION, deviceId: newId(), deviceLabel: null, createdAt: nowIso() }
  writeJsonAtomic(dataFile('device.json'), created)
  logEvent('info', 'device-created', created.deviceId)
  return created
}

/**
 * 设置本机显示名。
 * @param {string} label 用户输入；空串表示清除。
 * @returns {{ deviceId: string, deviceLabel: string|null }} 更新后的身份。
 */
export function setDeviceLabel(label) {
  const device = loadDevice()
  const next = clipString(label, 60)
  writeJsonAtomic(dataFile('device.json'), { ...device, deviceLabel: next, updatedAt: nowIso() })
  return { deviceId: device.deviceId, deviceLabel: next }
}

/** @returns {string} 本机设备 ID（不存在则创建）。 */
export function deviceId() {
  return loadDevice().deviceId
}

/* -------------------------------------------------------------- 来源归一化 */

/**
 * 去掉 URL 里的用户信息、查询串与片段，只留 `host/path`。
 *
 * 云文件里不允许出现凭据：带令牌的下载 URL、私有仓库地址都可能夹带 token，
 * 而历史文件的目的是「重新安装」，不需要任何查询参数。
 * @param {string} input 原始 URL。
 * @returns {string|null} `host/path`，或 null（不是合法 URL）。
 */
export function redactUrl(input) {
  try {
    const url = new URL(input)
    const query = [...url.searchParams.entries()].some(([name]) => SENSITIVE_PARAM.test(name))
    if (query) logEvent('info', 'url-query-dropped', 'dropped query string carrying credentials')
    return `${url.host}${url.pathname}`
  } catch {
    return null
  }
}

/**
 * 是否是本机路径来源（`link:` / `file:` / 绝对路径 / 相对路径）。
 * @param {string} spec 安装 spec。
 * @returns {boolean} 判定结果。
 */
export function isLocalSpec(spec) {
  return /^(?:link:|file:|~[\\/]|\.{1,2}[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(spec)
}

/**
 * 解析 Git 形态的安装 spec，归一到 `github.com/owner/repo#ref`。
 *
 * 支持 `github:o/r#ref`、`gitlab:o/r`、`git+https://host/o/r.git#ref`、
 * `git@host:o/r.git`、以及 npm 的裸 `o/r` 简写（按 GitHub 解释）。
 * 刻意丢弃用户信息与多余路径 —— 私有仓库地址里可能带 token。
 * @param {string} spec 安装 spec。
 * @returns {{ host: string, owner: string, repo: string, ref: string|null, key: string, installSpec: string }|null} 解析结果。
 */
export function parseGitSpec(spec) {
  if (typeof spec !== 'string' || spec === '') return null
  let rest = spec
  let host = null

  const prefixed = /^(github|gitlab|bitbucket):(.+)$/i.exec(rest)
  if (prefixed) {
    host = GIT_HOST_PREFIX[prefixed[1].toLowerCase()]
    rest = prefixed[2]
  } else {
    const url = /^(?:git\+)?(?:https?|ssh|git):\/\/([^/]+)\/(.+)$/i.exec(rest)
    if (url) {
      host = url[1].includes('@') ? url[1].slice(url[1].lastIndexOf('@') + 1) : url[1]
      rest = url[2]
    } else {
      const scp = /^(?:[^@/\s]+@)?([\w.-]+\.[a-z]{2,}):(.+)$/i.exec(rest)
      if (scp) {
        host = scp[1]
        rest = scp[2]
      } else {
        const shorthand = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.*))?$/.exec(rest)
        if (shorthand === null) return null
        return finishGit('github.com', shorthand[1], shorthand[2], shorthand[3])
      }
    }
  }

  const match = /^([^/#\s]+)\/([^/#\s]+?)(?:\.git)?(?:#(.*))?$/.exec(rest)
  if (match !== null) return finishGit(host, match[1], match[2], match[3])

  // 带子目录的 git spec（`o/r/sub`）用宽松兜底：宁可保留仓库身份，也别误判成 registry。
  const loose = /^([^/#\s]+)\/([^/#\s]+?)(?:\.git)?(?:[/#].*)?$/.exec(rest)
  if (loose !== null) return finishGit(host, loose[1], loose[2], null)
  return null
}

/**
 * 收尾 Git 解析：裁 ref、拼 key 与可重装 spec。
 * @param {string} host 主机名。
 * @param {string} owner 仓库属主。
 * @param {string} repo 仓库名。
 * @param {string|undefined} ref 分支 / 标签 / 提交，可能带 `&path:` 子目录。
 * @returns {{ host: string, owner: string, repo: string, ref: string|null, key: string, installSpec: string }} 归一化结果。
 */
function finishGit(host, owner, repo, ref) {
  const cleanRef = typeof ref === 'string' && ref.trim() !== '' ? ref.trim().slice(0, 120).replace(/\s+/g, '') : null
  const base = `${host}/${owner}/${repo}`
  const installSpec = host === 'github.com'
    ? `github:${owner}/${repo}${cleanRef === null ? '' : `#${cleanRef}`}`
    : `git+https://${base}.git${cleanRef === null ? '' : `#${cleanRef}`}`
  return { host, owner, repo, ref: cleanRef, key: `git:${base}${cleanRef === null ? '' : `#${cleanRef}`}`, installSpec }
}

/**
 * 把一个安装 spec 归一到稳定的 key 与可重装 spec。
 *
 * key 是跨设备匹配的依据，因此必须与提交形态无关：同一仓库的 `github:o/r#sha`
 * 与 `git+https://github.com/o/r.git#sha` 必须得到同一个 key。
 * @param {{ installSpec?: string|null, packageName?: string|null, version?: string|null }} input 来源信息。
 * @returns {{ sourceType: string, key: string, installSpec: string|null, reinstallable: boolean }} 归一化结果。
 */
export function normalizeSource(input) {
  const spec = typeof input.installSpec === 'string' ? input.installSpec.trim() : ''
  const name = typeof input.packageName === 'string' ? input.packageName.trim() : ''
  const version = typeof input.version === 'string' ? input.version.trim() : ''
  const at = version === '' ? 'unknown' : version

  // 本机路径：只记包名与版本，路径本身绝不进云文件（每台机器的盘符与目录都不同）。
  if (spec !== '' && isLocalSpec(spec)) {
    return {
      sourceType: 'local',
      key: `local:${name === '' ? 'unknown' : name}@${at}`,
      installSpec: null,
      reinstallable: false,
    }
  }

  const git = spec === '' ? null : parseGitSpec(spec)
  if (git !== null) {
    return { sourceType: 'git', key: git.key, installSpec: git.installSpec, reinstallable: true }
  }

  if (/^https?:\/\//i.test(spec)) {
    const redacted = redactUrl(spec)
    if (redacted !== null) {
      return { sourceType: 'tarball', key: `tarball:${redacted}`, installSpec: redacted, reinstallable: true }
    }
    // 看着像 URL 却解析不了：绝不能再掉进下面的 registry 分支把原始串当包名存下来，
    // 那样一个畸形 URL 里夹带的凭据就有机会进云文件。宁可标成不可重装。
    return {
      sourceType: 'url',
      key: `url:${name === '' ? 'unknown' : name}@${at}`,
      installSpec: null,
      reinstallable: false,
    }
  }

  // registry：`name` 或 `name@range`。version 由调用方（安装结果 / inspect）提供。
  const registryName = name === '' ? spec : name
  const key = `registry:${registryName === '' ? 'unknown' : registryName}@${at}`
  return {
    sourceType: 'registry',
    key,
    installSpec: registryName === '' ? null : `${registryName}@${at}`,
    reinstallable: registryName !== '',
  }
}

/* ------------------------------------------------------------------ 事件校验 */

/** 判定字符串字段：类型、长度、路径穿越。 */
function safeField(value, max, { allowNull = false } = {}) {
  if (value === null || value === undefined) return allowNull ? null : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max || NO_TRAVERSAL.test(trimmed)) return undefined
  return trimmed
}

/**
 * 严格校验一条事件。
 *
 * 来自远端 JSON 的事件一律按不可信输入处理：超长字段、路径穿越、异常 spec、
 * 未知 schema 全部拒收。返回 null 表示这条事件不可用。
 * @param {unknown} raw 待校验值。
 * @returns {object|null} 规范化后的事件，或 null。
 */
export function validateEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = /** @type {Record<string, unknown>} */ (raw)

  const eventId = safeField(value.eventId, 64)
  if (eventId === undefined || !ID_RE.test(eventId)) return null

  const kind = typeof value.kind === 'string' && KINDS.has(value.kind) ? value.kind : null
  if (kind === null) return null

  const key = safeField(value.key, 200)
  if (key === undefined) return null

  const packageName = safeField(value.packageName, 200)
  if (packageName === undefined) return null

  const version = safeField(value.version, 100, { allowNull: true })
  if (version === undefined) return null

  const installSpec = safeField(value.installSpec, 300, { allowNull: true })
  if (installSpec === undefined) return null
  // 二次防线：即便上游漏了归一化，也不允许凭据混进云文件。
  if (installSpec !== null && /(@[^/]*(?::|%3A)[^/]*@|(?:token|sign|signature|access_key|secret)=)/i.test(installSpec)) return null

  const sourceType = typeof value.sourceType === 'string' && SOURCE_TYPES.has(value.sourceType) ? value.sourceType : null
  if (sourceType === null) return null

  const device = safeField(value.deviceId, 64)
  if (device === undefined || !ID_RE.test(device)) return null

  const provenance = typeof value.provenance === 'string' && PROVENANCE_VALUES.has(value.provenance) ? value.provenance : null
  if (provenance === null) return null

  const installedAt = isIsoTimestamp(value.installedAt) ? value.installedAt : null
  const observedAt = isIsoTimestamp(value.observedAt) ? value.observedAt : null
  if (kind === KIND_INSTALLED && installedAt === null) return null
  if (kind === KIND_DISCOVERED && observedAt === null) return null

  const reinstallable = typeof value.reinstallable === 'boolean' ? value.reinstallable : sourceType !== 'local'

  return {
    eventId,
    kind,
    key,
    packageName,
    version,
    installSpec,
    sourceType,
    reinstallable,
    ...(installedAt === null ? {} : { installedAt }),
    ...(observedAt === null ? {} : { observedAt }),
    deviceId: device,
    provenance,
  }
}

/**
 * 由稳定内容派生事件 ID。
 *
 * 补录来源（市场日志、启动扫描）必须用它，而不是随机 UUID：这类事件的「同一个
 * 事实」会被反复重新解析（每次核对都重读一遍日志），随机 ID 会让 eventId 去重
 * 完全失效，账本里就会堆出重复条目。内容不变 → ID 不变 → 天然幂等。
 * @param {...unknown} parts 参与派生的稳定字段。
 * @returns {string} 40 位十六进制摘要（满足事件 ID 的字符集约束）。
 */
export function deriveEventId(...parts) {
  return createHash('sha256').update(parts.map(part => String(part ?? '')).join('\u0000')).digest('hex').slice(0, 40)
}

/**
 * 市场日志补录事件的确定性 ID。
 *
 * 刻意只依赖事件自身落盘的字段（设备、包名、归一化 key、安装时间），
 * 这样 `compactEntries` 能只看账本就把同一条事实认出来 —— 不需要重读市场日志。
 * @param {{ deviceId: string, packageName: string, key: string, installedAt?: string }} entry 事件字段。
 * @returns {string} 确定性事件 ID。
 */
export function marketEventId(entry) {
  return deriveEventId('market', entry.deviceId, entry.packageName, entry.key, entry.installedAt)
}

/**
 * 启动扫描「首见」事件的确定性 ID。
 * @param {{ deviceId: string, packageName: string, version?: string|null }} entry 事件字段。
 * @returns {string} 确定性事件 ID。
 */
export function scanEventId(entry) {
  return deriveEventId('scan', entry.deviceId, entry.packageName, entry.version ?? '')
}

/**
 * 补录类事件的「事实身份」。
 *
 * 只有补录来源（市场日志 / 启动扫描）才有事实身份 —— 它们描述的是「曾经发生过
 * 的某个确定事实」，重复解析必须收敛成一条。实时事件（真实安装、重装、升级）
 * 每次都是一次独立发生的事实，没有身份，必须全部保留。
 * @param {object} entry 事件。
 * @returns {{ key: string, preferredId: string }|null} 身份与新版本应使用的 ID；实时事件返回 null。
 */
function eventIdentity(entry) {
  if (entry.provenance === PROVENANCE.marketLog) {
    return {
      key: `market|${entry.deviceId}|${entry.packageName}|${entry.key}|${entry.installedAt ?? ''}`,
      preferredId: marketEventId(entry),
    }
  }
  if (entry.provenance === PROVENANCE.profileScan && entry.kind === KIND_DISCOVERED) {
    return {
      key: `scan|${entry.deviceId}|${entry.packageName}|${entry.version ?? ''}`,
      preferredId: scanEventId(entry),
    }
  }
  return null
}

/**
 * 去重压缩：同一个补录事实只留一条，且优先保留确定性 ID 的那条。
 *
 * 存在的理由是自愈：早期版本给补录事件用了随机 ID，导致每次核对都往里追加
 * 重复条目。这里在**加载时**就把这类残留收敛掉，用户不需要手工删文件，
 * 也不需要重装插件。无身份的实时事件原样保留。
 * @param {object[]} entries 事件列表。
 * @returns {object[]} 压缩后的事件列表（保持原有顺序）。
 */
export function compactEntries(entries) {
  /** @type {Map<string, { index: number, preferred: boolean }>} */
  const kept = new Map()
  const result = []
  for (const entry of entries) {
    const identity = eventIdentity(entry)
    if (identity === null) {
      result.push(entry)
      continue
    }
    const existing = kept.get(identity.key)
    if (existing === undefined) {
      kept.set(identity.key, { index: result.length, preferred: entry.eventId === identity.preferredId })
      result.push(entry)
      continue
    }
    const isPreferred = entry.eventId === identity.preferredId
    // 只有「新的这条是确定性 ID、旧的不是」时才替换，其余重复一律丢弃。
    if (isPreferred && !existing.preferred) {
      result[existing.index] = entry
      existing.preferred = true
    }
  }
  return result
}

/**
 * 构造一条本机事件。
 *
 * `input.source` 可以传入已经归一化的来源（`normalizeSource` 的结果）。
 * 这一点很关键：local 来源的 `installSpec` 是 null（路径不入云），如果在这里
 * 重新推导，就会把 local 降级成 registry、把 `reinstallable` 从 false 变回 true。
 * @param {{ packageName: string, version?: string|null, installSpec?: string|null, source?: object, kind?: string, at?: string, provenance: string, eventId?: string }} input 事件内容。
 * @param {string} device 本机设备 ID。
 * @returns {object|null} 校验通过的事件，或 null。
 */
export function buildEntry(input, device) {
  const kind = input.kind ?? KIND_INSTALLED
  const source = input.source ?? normalizeSource(input)
  const at = isIsoTimestamp(input.at) ? input.at : nowIso()
  const raw = {
    eventId: input.eventId ?? newId(),
    kind,
    key: source.key,
    packageName: input.packageName,
    version: input.version ?? null,
    installSpec: source.installSpec,
    sourceType: source.sourceType,
    reinstallable: source.reinstallable,
    deviceId: device,
    provenance: input.provenance,
    ...(kind === KIND_INSTALLED ? { installedAt: at } : { observedAt: at }),
  }
  const valid = validateEntry(raw)
  if (valid === null) logEvent('warn', 'entry-rejected', `rejected ${kind} for ${String(input.packageName)}`)
  return valid
}

/* -------------------------------------------------------------------- 账本 */

/** @returns {{ schemaVersion: number, deviceId: string, updatedAt: string, entries: object[] }} 空账本。 */
function emptyHistory(device) {
  return { schemaVersion: SCHEMA_VERSION, deviceId: device, updatedAt: nowIso(), entries: [] }
}

/**
 * 读取本机账本；文件损坏时退回空账本（绝不因为账本坏掉就崩掉 profile 启动）。
 * @param {string} device 本机设备 ID。
 * @returns {{ schemaVersion: number, deviceId: string, updatedAt: string, entries: object[] }} 账本。
 */
export function loadHistory(device = deviceId()) {
  const raw = readJsonFile(dataFile('history.json'), null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyHistory(device)
  const value = /** @type {Record<string, unknown>} */ (raw)
  const list = Array.isArray(value.entries) ? value.entries : []
  const entries = []
  const seen = new Set()
  for (const item of list) {
    const valid = validateEntry(item)
    if (valid === null || seen.has(valid.eventId)) continue
    seen.add(valid.eventId)
    entries.push(valid)
  }
  const compacted = compactEntries(entries)
  if (compacted.length !== entries.length) {
    // 自愈：旧版本留下的重复补录条目在这里被丢掉，并立刻写回磁盘，
    // 免得每次加载都要再压一遍、也免得重复条目被同步到云上。
    const healed = {
      schemaVersion: SCHEMA_VERSION,
      deviceId: typeof value.deviceId === 'string' && ID_RE.test(value.deviceId) ? value.deviceId : device,
      updatedAt: nowIso(),
      entries: compacted,
    }
    writeJsonAtomic(dataFile('history.json'), healed)
    logEvent('info', 'history-compacted', `dropped ${entries.length - compacted.length} duplicate backfill entries`)
    return healed
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof value.deviceId === 'string' && ID_RE.test(value.deviceId) ? value.deviceId : device,
    updatedAt: isIsoTimestamp(value.updatedAt) ? value.updatedAt : nowIso(),
    entries: compacted,
  }
}

/**
 * 追加事件（按 eventId 去重，超出上限丢最旧的）。
 * @param {object[]} additions 待追加事件（应先过 `validateEntry`）。
 * @returns {{ added: number, total: number }} 追加结果。
 */
export function appendEntries(additions) {
  const device = deviceId()
  const history = loadHistory(device)
  const seen = new Set(history.entries.map(entry => entry.eventId))
  let added = 0
  for (const entry of additions) {
    if (entry === null || entry === undefined) continue
    const valid = validateEntry(entry)
    if (valid === null || seen.has(valid.eventId)) continue
    seen.add(valid.eventId)
    history.entries.push(valid)
    added += 1
  }
  if (added === 0) return { added: 0, total: history.entries.length }
  if (history.entries.length > MAX_ENTRIES) {
    history.entries.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)))
    history.entries = history.entries.slice(history.entries.length - MAX_ENTRIES)
  }
  history.updatedAt = nowIso()
  writeJsonAtomic(dataFile('history.json'), history)
  return { added, total: history.entries.length }
}

/**
 * 事件的代表时间：确证用安装时间，补录用首见时间。
 * @param {object} entry 事件。
 * @returns {string} ISO-8601 字符串。
 */
export function timestampOf(entry) {
  return entry.kind === KIND_INSTALLED ? (entry.installedAt ?? entry.observedAt ?? '') : (entry.observedAt ?? entry.installedAt ?? '')
}

/**
 * 本机账本里出现过的包名集合。
 * @returns {Set<string>} 包名集合。
 */
export function knownPackages() {
  return new Set(loadHistory().entries.map(entry => entry.packageName))
}

/**
 * 按包聚合（历史页的主视图）：一个包一行，展开看每次安装事件。
 * @param {object[]} entries 事件列表（可含多设备）。
 * @returns {Array<{ packageName: string, version: string|null, latestAt: string, devices: string[], events: object[], reinstallable: boolean }>} 聚合结果，按最新时间倒序。
 */
export function aggregateByPackage(entries) {
  const buckets = new Map()
  for (const entry of entries) {
    const bucket = buckets.get(entry.packageName) ?? []
    bucket.push(entry)
    buckets.set(entry.packageName, bucket)
  }
  const rows = []
  for (const [packageName, events] of buckets) {
    events.sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)))
    const latest = events[0]
    rows.push({
      packageName,
      version: latest.version ?? null,
      latestAt: timestampOf(latest),
      devices: [...new Set(events.map(entry => entry.deviceId))],
      events,
      reinstallable: events.some(entry => entry.reinstallable === true && entry.kind === KIND_INSTALLED),
    })
  }
  rows.sort((a, b) => b.latestAt.localeCompare(a.latestAt))
  return rows
}

/**
 * 校验一份远端历史文件（阶段 2 从网盘拉回来的内容）。
 *
 * 与本地账本共用同一套事件校验；额外要求显式 schemaVersion 与 deviceId，
 * 未知 schema 一律拒收 —— 未来的格式变更必须走新 schema 号。
 * @param {unknown} raw 解析后的 JSON。
 * @returns {{ deviceId: string, deviceLabel: string|null, updatedAt: string|null, entries: object[] }|null} 结果，或 null。
 */
export function validateRemoteDocument(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = /** @type {Record<string, unknown>} */ (raw)
  if (value.schemaVersion !== SCHEMA_VERSION) return null
  const device = safeField(value.deviceId, 64)
  if (device === undefined || !ID_RE.test(device)) return null
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) return null
  const entries = []
  for (const item of value.entries) {
    const valid = validateEntry(item)
    if (valid === null) return null
    // 文件自称的设备必须与每条事件自称的设备一致，否则是拼装或篡改过的。
    if (valid.deviceId !== device) return null
    entries.push(valid)
  }
  return {
    deviceId: device,
    deviceLabel: clipString(value.deviceLabel, 60),
    updatedAt: isIsoTimestamp(value.updatedAt) ? value.updatedAt : null,
    entries,
  }
}

/**
 * 生成本设备的上传文档（阶段 2 写进网盘的那一份）。
 * @param {string|null} label 设备显示名。
 * @returns {object} 上传文档。
 */
export function buildUploadDocument(label) {
  const device = deviceId()
  const history = loadHistory(device)
  history.entries.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)))
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: device,
    deviceLabel: clipString(label, 60),
    updatedAt: nowIso(),
    entries: history.entries,
  }
}

/**
 * 稳定指纹，用于「同一份内容不必重复上传」的判断。
 * @param {unknown} value 任意值。
 * @returns {string} sha256 十六进制摘要。
 */
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 账本文件路径（诊断与阶段 2 会用到）。 */
export const HISTORY_FILE = join('history-plugin', 'history.json')

/** 插件包名（排除自身用）。 */
export { PLUGIN_ID }
