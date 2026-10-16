/**
 * dsh-history-plugin · 通用工具（宿主半边）
 *
 * 只放与业务无关的东西：DSH 目录解析、原子 JSON 读写、诊断日志、ID 与时间。
 * 记账与来源归一化在 `store.js`，安装事件采集在 `collector.js`。
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 包名；用于从 bundle 列表里排除插件自己。 */
export const PLUGIN_ID = 'dsh-history-plugin'

/** 本地账本与云端文件的 schema 版本。 */
export const SCHEMA_VERSION = 1

/** 诊断日志的轮转阈值，超过就整体挪成 `.1`（只留一代，够定位问题即可）。 */
const MAX_LOG_BYTES = 512 * 1024

/**
 * DSH 主目录。
 *
 * 优先读 `DSH_HOME`（launcher 会设置它，也是官方文档里 `$DSH_HOME` 的含义）；
 * 没有就退回 `~/.dsh` —— 与 `home-paths` 的默认位置一致。
 * @returns {string} DSH 主目录绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 本插件的数据目录（`$DSH_HOME/history-plugin/`）。
 *
 * 沿用 marketplace 的做法：插件在自己的 `$DSH_HOME` 子目录里用普通文件落盘，
 * 而不是去写 profile 目录 —— profile 归 plugin-manager 的写锁管，
 * 插件往里塞文件会跟 pnpm 与 HMR 抢同一个目录。
 * @returns {string} 数据目录绝对路径（保证已存在）。
 */
export function dataDir() {
  const dir = join(dshHome(), 'history-plugin')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** @returns {string} 本插件的数据文件路径。 */
export function dataFile(name) {
  return join(dataDir(), name)
}

/** @returns {string} 新的随机 UUID。 */
export function newId() {
  return randomUUID()
}

/** @returns {string} 当前时刻的 ISO-8601（UTC）字符串。 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * 追加一行 NDJSON 诊断日志。
 *
 * 刻意吞掉所有异常：记账失败绝不能让插件激活失败，更不能影响 profile 启动。
 * 注意：调用方不得把 access token、dlink 或含凭据的 spec 传进来。
 * @param {'info'|'warn'|'error'} level 日志级别。
 * @param {string} event 事件名（如 `install-recorded`）。
 * @param {string} detail 人类可读细节。
 */
export function logEvent(level, event, detail) {
  try {
    const file = dataFile('plugin.log')
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        const rotated = `${file}.1`
        try {
          unlinkSync(rotated)
        } catch {
          /* 上一代不存在就算了 */
        }
        renameSync(file, rotated)
      }
    } catch {
      /* 文件还不存在，或轮转失败——继续写就好 */
    }
    appendFileSync(file, `${JSON.stringify({ at: nowIso(), level, event, detail })}\n`, 'utf8')
  } catch {
    /* 日志失败不影响任何功能 */
  }
}

/**
 * 读一个 JSON 文件；任何失败（不存在、半截写入、非 JSON）都退回默认值。
 * @param {string} file 文件路径。
 * @param {unknown} fallback 失败时的返回值。
 * @returns {unknown} 解析结果或默认值。
 */
export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接覆写会让「写了一半就被 kill」留下无法解析的文件；rename 在同一卷上是
 * 原子的，读到的要么是旧内容要么是新内容。Windows 上 rename 会覆盖已存在目标。
 * @param {string} file 目标文件路径。
 * @param {unknown} value 要序列化的值。
 * @returns {boolean} 是否写成功。
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      // 极少数情况下目标被占用：删掉再 rename 一次。
      try {
        unlinkSync(file)
      } catch {
        /* 目标本来就不在 */
      }
      renameSync(tmp, file)
    }
    return true
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件没建起来 */
    }
    logEvent('error', 'write-failed', `${file}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * 清扫原子写留下的临时文件。
 *
 * `writeJsonAtomic` 正常路径与失败路径都会清掉自己的 `<file>.tmp-<pid>`，但**进程被
 * kill 在 write 与 rename 之间**时它来不及清，文件就永久留下了。这个函数在启动时
 * 扫一遍数据目录（含 `accounts/<账号>/` 一层），把**属于已死进程**的临时文件删掉。
 *
 * 只删进程已死的：同一台机器上可能有另一个 DSH 实例共享同一个 DSH_HOME，
 * 删掉它正在写的临时文件会真的坏事。判活失败（EPERM）时保守地当成活着。
 *
 * @param {string} [dir] 要清扫的目录，默认本插件数据目录。
 * @returns {{ removed: number, kept: number, names: string[] }} 清扫结果。
 */
export function sweepTempFiles(dir = dataDir()) {
  const result = { removed: 0, kept: 0, names: [] }
  /**
   * 有界递归收集目录：远端缓存写在 `accounts/<账号>/remote.json`，所以要下到第二层。
   * 深度封顶是为了不跟着一个意外的深目录结构跑飞。
   */
  const dirs = []
  const queue = [{ path: dir, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    dirs.push(current.path)
    if (current.depth >= 3) continue
    try {
      for (const entry of readdirSync(current.path, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
        }
      }
    } catch {
      /* 这一层读不到就跳过 */
    }
  }
  for (const current of dirs) {
    let names = []
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of names) {
      const match = /\.tmp-(\d+)$/.exec(entry)
      if (match === null) continue
      const pid = Number(match[1])
      // 自己正在写的临时文件当然不能删。
      if (pid === process.pid) {
        result.kept += 1
        continue
      }
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch (error) {
        // EPERM = 进程存在但不属于我，保守当作活着。
        alive = error?.code === 'EPERM'
      }
      if (alive) {
        result.kept += 1
        continue
      }
      try {
        unlinkSync(join(current, entry))
        result.removed += 1
        result.names.push(entry)
      } catch {
        /* 删不掉就算了，不值得为此影响启动。 */
      }
    }
  }
  return result
}

/**
 * 把任意输入裁成一个安全的短字符串（用于设备显示名等用户输入）。
 * @param {unknown} value 原始值。
 * @param {number} max 最大长度。
 * @returns {string|null} 裁剪后的字符串；不是字符串时返回 null。
 */
export function clipString(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 判断字符串是否是 ISO-8601 时间戳。
 * @param {unknown} value 待判定值。
 * @returns {boolean} 是否是合法的 ISO-8601。
 */
export function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

/** @returns {boolean} 是否已存在该文件。 */
export function fileExists(file) {
  return existsSync(file)
}
