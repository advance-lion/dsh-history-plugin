/**
 * 批量重装：把「别的设备装过、本机没有」的插件一次装回来。
 *
 * 这个文件的写法完全由读源码得到的四个事实决定，四个都跟直觉相反：
 *
 *  1. `installBundle(spec, options)` **跑完才 resolve**，返回的是整次安装的
 *     `ChangeResult`。所以 `await` 它就已经拿到结论了。
 *  2. `waitForInstall(requestId)` 只能用来**恢复一个还在跑的**安装：它的实现是
 *     `installs.get(requestId)?.result ?? null`，而 `installBundle` 的 `.finally`
 *     在结束时就把该 id 从登记表里删掉。所以「先 await installBundle，再
 *     waitForInstall」**永远只会拿到 null**——源码注释也写明「已完成的结果不保留，
 *     null 既不能证明成功也不能证明取消」。
 *  3. 失败**不是抛出来的**。`change()` 把 `ManagementFailure` 折进返回值：
 *     `application: 'failed'`，错误码在 `error.code`（非 ManagementFailure 时为
 *     `'operation-error'`）。只有文件锁或插件释放这类错误才会真的抛。
 *  4. 成功也不是 `status:'accepted'`——那是 `inspect` 的形态。安装成功的标志是
 *     `application`，取值 `applied`（已即时生效）/ `restart-required`（需重启）/
 *     `cancelled` / `failed`。返回的 `status` 字段在安装结果里根本不存在。
 *
 * 串行执行：pnpm 装包会写 profile，并发只会互相打架；重装是低频动作，串行可以接受。
 * `bundle-in-use` / `ambiguous-install` 属于「现在不行、等会儿也许行」（通常是别的
 * 安装或代理在跑），退避重试；其余一律如实报错，不假装成功。
 */

/** 单次安装的结果状态。 */
export const REINSTALL_STATUS = Object.freeze({
  installed: 'installed',
  present: 'present',
  refused: 'refused',
  unknown: 'unknown',
})

/** `application` 里代表成功的两种取值。 */
const SUCCESS_APPLICATIONS = new Set(['applied', 'restart-required'])

/** 值得退避重试的错误码。 */
const RETRYABLE_CODES = new Set(['bundle-in-use', 'ambiguous-install'])
/** 重试前等待的毫秒数；长度即最大重试次数。 */
const RETRY_DELAYS = [2000, 8000, 20000]

/**
 * 从抛出的错误里取出错误码。取不到就返回 null——不要猜。
 * @param {unknown} error 抛出的错误。
 * @returns {{ code: string|null, message: string }} 分类结果。
 */
export function classifyInstallError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error !== null && typeof error === 'object') {
    const value = /** @type {Record<string, unknown>} */ (error)
    if (typeof value.code === 'string' && value.code !== '') return { code: value.code, message }
    if (typeof value.name === 'string' && value.name !== '' && value.name !== 'Error') {
      return { code: value.name, message }
    }
  }
  return { code: null, message }
}

/**
 * 把一个安装结果翻译成我们的结论。
 * @param {unknown} result `installBundle` 的返回值。
 * @returns {{ outcome: string, code: string|null, reason: string|null, application: string|null, changed: boolean }} 结论。
 */
export function readInstallResult(result) {
  if (result === null || typeof result !== 'object') {
    return { outcome: 'unknown', code: null, reason: '管理服务没有返回安装结果', application: null, changed: false }
  }
  const value = /** @type {Record<string, unknown>} */ (result)
  const application = typeof value.application === 'string' ? value.application : null
  const changed = value.changed === true
  if (application !== null && SUCCESS_APPLICATIONS.has(application)) {
    return { outcome: 'installed', code: null, reason: null, application, changed }
  }
  if (application === 'cancelled') {
    return { outcome: 'cancelled', code: null, reason: '安装被取消', application, changed }
  }
  const error = value.error !== null && typeof value.error === 'object' ? /** @type {Record<string, unknown>} */ (value.error) : null
  const code = error !== null && typeof error.code === 'string' ? error.code : null
  const diagnostic = error !== null && typeof error.diagnostic === 'string' ? error.diagnostic : null
  const reason = code === null
    ? (application === 'failed' ? '安装失败，但管理服务没有给出错误码' : `安装结果异常（application=${String(application)}）`)
    : `${code}${diagnostic === null ? '' : `：${diagnostic}`}`
  return { outcome: 'failed', code, reason, application, changed }
}

/**
 * 创建重装器。
 * @param {{ getManager: () => any, log?: (level: string, event: string, detail: string) => void, sleep?: (ms: number) => Promise<void> }} options 依赖。
 * @returns {object} 重装器。
 */
export function createReinstaller(options) {
  const log = options.log ?? (() => {})
  const sleep = options.sleep ?? (ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }))
  let counter = 0

  /** 管理服务是否可用。 */
  function manager() {
    const value = options.getManager()
    return value !== null && typeof value === 'object' ? value : null
  }

  /**
   * 预检：一条条 inspect，把「现在就装不了」的挑出来，避免批量跑到一半才发现。
   * 不改动任何东西。注意 inspect 的成功形态是 `status:'accepted'`，与安装不同。
   * @param {object[]} rows 待装的行（含 packageName 与 installSpec）。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<object[]>} 每条的预检结果。
   */
  async function plan(rows, signal) {
    const service = manager()
    const results = []
    for (const row of rows) {
      if (row.installSpec === null || row.installSpec === undefined) {
        results.push({
          packageName: row.packageName,
          status: REINSTALL_STATUS.refused,
          reason: '没有可重装的来源（本地 link 安装无法在别的机器上复现）',
        })
        continue
      }
      if (service === null || typeof service.inspect !== 'function') {
        results.push({ packageName: row.packageName, status: REINSTALL_STATUS.unknown, reason: '管理服务不可用' })
        continue
      }
      try {
        const facts = await service.inspect(row.installSpec, {}, signal)
        if (facts?.status === 'accepted') {
          results.push({
            packageName: row.packageName,
            status: 'ready',
            spec: row.installSpec,
            kind: facts.kind ?? null,
            version: facts.version ?? null,
          })
        } else {
          results.push({
            packageName: row.packageName,
            status: REINSTALL_STATUS.refused,
            spec: row.installSpec,
            code: facts?.problem ?? null,
            reason: `${facts?.problem ?? '未知'}：${facts?.reason ?? ''}`.trim(),
          })
        }
      } catch (error) {
        const classified = classifyInstallError(error)
        results.push({
          packageName: row.packageName,
          status: REINSTALL_STATUS.refused,
          spec: row.installSpec,
          reason: classified.message,
          code: classified.code,
        })
      }
    }
    return results
  }

  /**
   * 发起一次安装并读结论。
   * @param {object} row 待装的行。
   * @returns {Promise<object>} 结论。
   */
  async function attempt(row) {
    const service = manager()
    if (service === null || typeof service.installBundle !== 'function') {
      return { outcome: 'unknown', code: null, reason: '管理服务不可用', application: null, changed: false, requestId: null }
    }
    counter += 1
    // requestId 由调用方生成：它会随 install-state 事件广播出去，也让取消能指名道姓。
    const requestId = `history-plugin-${Date.now().toString(36)}-${counter}`
    try {
      const result = await service.installBundle(row.installSpec, { requestId })
      return { ...readInstallResult(result), requestId }
    } catch (error) {
      // 只有文件锁/插件释放这类错误才会走到这里；安装失败本身在返回值里。
      const classified = classifyInstallError(error)
      return { outcome: 'failed', code: classified.code, reason: classified.message, application: null, changed: false, requestId }
    }
  }

  /**
   * 装一个，必要时退避重试。
   * @param {object} row 待装的行。
   * @param {(event: object) => void} onProgress 进度回调。
   * @returns {Promise<object>} 结果。
   */
  async function installOne(row, onProgress) {
    let attemptIndex = 0
    for (;;) {
      onProgress?.({ packageName: row.packageName, phase: 'installing', attempt: attemptIndex })
      const outcome = await attempt(row)
      if (outcome.outcome === 'installed') {
        return {
          packageName: row.packageName,
          status: REINSTALL_STATUS.installed,
          requestId: outcome.requestId,
          // applied 表示已生效；restart-required 需要重启 DSH——别把这两件事说成一样。
          application: outcome.application,
          needsRestart: outcome.application === 'restart-required',
        }
      }
      if (outcome.outcome === 'unknown') {
        return { packageName: row.packageName, status: REINSTALL_STATUS.unknown, reason: outcome.reason }
      }
      const code = outcome.code
      if (code !== null && RETRYABLE_CODES.has(code) && attemptIndex < RETRY_DELAYS.length) {
        const wait = RETRY_DELAYS[attemptIndex]
        attemptIndex += 1
        onProgress?.({ packageName: row.packageName, phase: 'waiting', code, waitMs: wait, attempt: attemptIndex })
        log('info', 'reinstall-retry', `${row.packageName} 被 ${code} 挡住，${wait}ms 后重试（第 ${attemptIndex} 次）`)
        await sleep(wait)
        continue
      }
      return {
        packageName: row.packageName,
        status: REINSTALL_STATUS.refused,
        reason: outcome.reason,
        code,
        retryable: code !== null && RETRYABLE_CODES.has(code),
      }
    }
  }

  return {
    plan,
    installOne,
    /**
     * 串行重装。
     * @param {object[]} rows 待装的行。
     * @param {{ skipPresent?: boolean, onProgress?: (event: object) => void, signal?: AbortSignal }} [params] 选项。
     * @returns {Promise<{ results: object[], installed: number, skipped: number, failed: number, needsRestart: number }>} 汇总。
     */
    async run(rows, params = {}) {
      const onProgress = params.onProgress
      const skipPresent = params.skipPresent !== false
      const results = []
      for (const row of rows) {
        if (params.signal?.aborted === true) {
          results.push({ packageName: row.packageName, status: REINSTALL_STATUS.unknown, reason: '已取消' })
          continue
        }
        if (skipPresent && row.present === true) {
          results.push({ packageName: row.packageName, status: REINSTALL_STATUS.present })
          continue
        }
        if (row.installSpec === null || row.installSpec === undefined) {
          results.push({
            packageName: row.packageName,
            status: REINSTALL_STATUS.refused,
            reason: '没有可重装的来源（本地 link 安装无法在别的机器上复现）',
          })
          continue
        }
        onProgress?.({ packageName: row.packageName, phase: 'starting' })
        const result = await installOne(row, onProgress)
        onProgress?.(result)
        results.push(result)
      }
      return {
        results,
        installed: results.filter(item => item.status === REINSTALL_STATUS.installed).length,
        skipped: results.filter(item => item.status === REINSTALL_STATUS.present).length,
        failed: results.filter(item => item.status === REINSTALL_STATUS.refused || item.status === REINSTALL_STATUS.unknown).length,
        needsRestart: results.filter(item => item.needsRestart === true).length,
      }
    },
  }
}
