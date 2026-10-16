/**
 * 云端目录迁移：把本账号的历史副本从当前目录搬到新目录。
 *
 * 方案要求「先验证新目录可读写、复制并核对成功，再更新固定位置的目录指针；其他设备
 * 同步前重新读取指针。旧目录清理须单独确认」。这里的顺序就是照着这句话排的，而且
 * **每一步失败都不改动任何东西**：
 *
 *   1. 校验新目录（绝对路径、无 `..` / `.` 段）
 *   2. 在新目录里做一次读写探针（写 → 逐字节读回 → 删除）；不通就原样返回
 *   3. 逐个复制副本到新目录，并逐字节读回核对
 *   4. **全部核对通过之后**，才把固定位置的目录指针指向新目录
 *   5. 旧目录清理必须由调用方第二次明确要求（`removeOld: true`）才做
 *
 * 第 4 步为什么必须在核对之后：别的设备只认固定位置的指针。指针一动它们就去新目录
 * 读，如果那时新目录还没铺好数据，它们会认为「没有任何历史」——比不迁移更糟。
 *
 * 另有一个必须提防的坑：目标 transport 一定要用 `ignorePointer` 创建，否则它会读到
 * 旧指针、把副本写回**旧目录**，而「读回核对」还会照样通过（读的正是刚写进去的那份）。
 */

import { SCHEMA_VERSION } from './util.js'

/** 副本目录在云端根目录下的子路径，与 baidu.js 的 REPLICAS_SUBDIR 一致。 */
export const REPLICAS_SUBDIR = 'v1/replicas'

/** 迁移结果状态。 */
export const MIGRATE_STATUS = Object.freeze({
  /** 搬完了（旧目录是否清理看 cleanup）。 */
  moved: 'moved',
  /** 目标目录就是当前目录，什么都没做。 */
  sameDir: 'same-dir',
  /** 动手之前就拒绝了：目录非法或目标不可写。**没有改动任何东西**。 */
  refused: 'refused',
  /** 复制过程中核对失败，已停手：指针没动，旧目录原样保留。 */
  failed: 'failed',
})

/**
 * 校验一个云端目录值。
 * @param {unknown} raw 原始输入。
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }} 结果。
 */
export function validateRemoteDir(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, error: '云端目录不能为空' }
  if (!text.startsWith('/')) return { ok: false, error: '云端目录必须是绝对路径（以 / 开头）' }
  if (text.length > 512) return { ok: false, error: '云端目录过长' }
  if (text.includes('\u0000')) return { ok: false, error: '云端目录含非法字符' }
  const dir = text.replace(/\/+$/, '')
  const segments = dir.split('/').filter(segment => segment !== '')
  if (segments.length === 0) return { ok: false, error: '云端目录不能是根目录' }
  if (segments.includes('..') || segments.includes('.')) return { ok: false, error: '云端目录里不能有 .. 或 . 段' }
  return { ok: true, dir }
}

/**
 * 建立迁移器。
 *
 * @param {{ createTransport: (options?: { remoteDir?: string|null, ignorePointer?: boolean }) => any, onWarn?: (message: string) => void }} options 依赖。
 * @returns {{ run: (params?: object) => Promise<object> }} 迁移器。
 */
export function createMigrator(options) {
  const onWarn = options.onWarn ?? (() => {})

  /**
   * 执行迁移。
   * @param {{ to?: string, removeOld?: boolean }} [params] 参数。
   * @returns {Promise<object>} 结果（status 见 MIGRATE_STATUS）。
   */
  async function run(params = {}) {
    const checked = validateRemoteDir(params.to)
    if (checked.ok !== true) {
      return { status: MIGRATE_STATUS.refused, reason: 'invalid-dir', error: checked.error }
    }
    const to = checked.dir

    const source = options.createTransport({})
    await source.ensureDirs()
    const fromRoot = source.remoteDir
    const fromReplicasDir = source.replicasDir
    const targetReplicasDir = `${to}/${REPLICAS_SUBDIR}`

    // 目标就是当前**生效**的目录时什么都不做。比的是生效的副本目录，而不只是配置值：
    // 迁移过一次之后，配置里可能还是默认目录，而数据已经被指针指到别处了。
    if (to === fromRoot || targetReplicasDir === fromReplicasDir) {
      return { status: MIGRATE_STATUS.sameDir, to, from: fromRoot, replicasDir: fromReplicasDir }
    }

    // 2. 目标目录先探活。不通就原样返回——此刻云端一个字节都没变。
    const target = options.createTransport({ remoteDir: to, ignorePointer: true })
    const probe = await target.probe()
    if (probe.ok !== true) {
      return {
        status: MIGRATE_STATUS.refused,
        reason: 'target-unwritable',
        to,
        from: fromRoot,
        error: probe.error ?? '目标目录不可写',
        probe,
      }
    }

    // 3. 复制 + 逐字节核对。任何一份对不上就停手。
    const files = await source.listReplicas()
    const copied = []
    const skipped = []
    let bytes = 0
    for (const file of files) {
      const name = typeof file?.name === 'string' ? file.name : ''
      if (name === '') {
        skipped.push('(无名文件)')
        continue
      }
      const buffer = await source.readReplica(name)
      if (buffer === null) {
        skipped.push(name)
        continue
      }
      await target.writeReplica(name, buffer)
      const back = await target.readReplica(name)
      if (back === null || !back.equals(buffer)) {
        return {
          status: MIGRATE_STATUS.failed,
          reason: 'verify-failed',
          to,
          from: fromRoot,
          copied: copied.length,
          verified: copied.length,
          skipped,
          error: `${name} 复制后核对不一致：已停手，目录指针未改动，旧目录原样保留`,
        }
      }
      bytes += buffer.length
      copied.push(name)
    }

    // 4. 全部核对通过，才动固定位置的指针。别的设备下次读指针就会去新目录。
    await target.writeLocation({
      schemaVersion: SCHEMA_VERSION,
      replicasDir: targetReplicasDir,
      createdAt: new Date().toISOString(),
      migratedAt: new Date().toISOString(),
      migratedFrom: fromRoot,
    })

    // 5. 旧目录清理：只有显式要求才做，而且绝不能删到新目录上。
    //    先逐个删副本文件：真正的数据在那里，而「删非空目录」是否被服务端接受并不确定
    //    （服务端可能回 errno -9 拒绝），所以目录清理只是尽力而为的收尾。
    let cleanup = { requested: false, removedFiles: 0, dirRemoved: false, pending: true, dir: fromReplicasDir }
    if (params.removeOld === true) {
      cleanup = { requested: true, removedFiles: 0, dirRemoved: false, pending: false, dir: fromReplicasDir }
      const failures = []
      if (fromReplicasDir === targetReplicasDir) {
        cleanup.error = '旧目录与新目录是同一个，未清理'
      } else {
        for (const name of copied) {
          try {
            const deletion = await source.deleteReplica(name)
            if (deletion?.removed === true) cleanup.removedFiles += 1
            else failures.push(name)
          } catch (error) {
            failures.push(name)
            onWarn(`清理旧副本 ${name} 失败：${error?.message ?? error}`)
          }
        }
        try {
          cleanup.dirRemoved = (await source.deletePath(fromReplicasDir))?.removed === true
        } catch (error) {
          onWarn(`清理旧目录失败（新目录已生效，不影响同步）：${error?.message ?? error}`)
        }
      }
      if (failures.length > 0) cleanup.error = `有 ${failures.length} 个旧副本未清理：${failures.join(', ')}`
    }

    return {
      status: MIGRATE_STATUS.moved,
      to,
      from: fromRoot,
      replicasDir: targetReplicasDir,
      copied: copied.length,
      verified: copied.length,
      bytes,
      skipped,
      probe,
      cleanup,
    }
  }

  return { run }
}
