/**
 * 百度网盘传输层：只负责「把一段字节放进网盘、再取回来」。
 *
 * 这里每一条怪规则都是实测出来的，不是照文档写的 —— 文档和实际行为不一致：
 *
 *  1. **`rtype=1` 建目录会静默生成重名副本。** 对已存在目录传 rtype=1，返回
 *     errno 0，却在旁边建出 `dsh-history-plugin_20261013_111126`。实测一次探针
 *     就在用户网盘里留下 9 个多余目录。所以建目录一律 `rtype=0`，并把
 *     errno -8（已存在）当成成功。
 *
 *  2. **`create` 的 `rtype=2` 并不覆盖。** 文档写「2=路径冲突覆盖」，实际生成
 *     `name(1).json`，原文件纹丝不动 —— 于是每次上传都会堆一个新文件，而按名字
 *     读回来的永远是第一版。所以更新文件走「先按路径删除，再上传」，永不依赖
 *     覆盖语义。
 *
 *  3. **覆盖写会换 `fs_id`，旧 `fs_id` 仍解析出旧内容。** 因此绝不缓存 fs_id：
 *     每次读都重新列目录、取当前 fs_id、再换 dlink。缓存 fs_id 会读到过期内容。
 *
 *  4. **分片上传成功时不返回 `errno` 字段**，只有 `{md5, request_id}`；把
 *     `errno !== 0` 当失败会把成功判成失败。所以只在 `errno` 存在且非 0 时才失败。
 *
 *  5. 下载 dlink 的 host 是 `d.pcs.baidu.com`，必须带 `User-Agent: pan.baidu.com`。
 *
 *  6. **`list` / `create` 返回的 `md5` 不是内容 md5。** 实测同一个 81 字节文件，
 *     本地内容 md5 是 `36e9c489…`，网盘返回 `a1d1adf8bv42…` —— 中间直接出现字母
 *     `v`，根本不是十六进制，是网盘自己的签名。拿它比对会把每一次正常下载都判成
 *     损坏。完整性校验因此改用「字节数一致 + 上层严格 schema 校验」。
 *
 * 安全：access token 只出现在请求 URL 里，永不写入历史文件、永不进日志；
 * 所有抛出的错误都经过脱敏。
 */

import { createHash } from 'node:crypto'

/** 主 API 主机。 */
export const API_BASE = 'https://pan.baidu.com'
/** 分片上传主机。 */
export const PCS_BASE = 'https://d.pcs.baidu.com'
/** 网盘要求带这个 UA，否则部分接口拒绝。 */
export const USER_AGENT = 'pan.baidu.com'
/** 单个历史文件的大小上限，与账本上限一致。 */
export const MAX_REMOTE_BYTES = 1024 * 1024
/** 默认云端目录。正式 OAuth 应用通常只能写 `/apps/<appname>/`，故可配置。 */
export const DEFAULT_REMOTE_DIR = '/dsh-history-plugin'
/** 每个设备一份副本文件，放在这个子目录下。 */
export const REPLICAS_SUBDIR = 'v1/replicas'
/** 目录指针文件：记录副本目录位置，便于云端目录被移动后仍能找到。 */
export const LOCATION_FILE = 'location.json'
/**
 * 目录指针的**固定**位置：永远在默认目录下。
 *
 * 这是新设备唯一的发现入口：用户把历史搬到自定义目录后，指针留在原处指向新目录，
 * 别的设备（还用着默认配置）先读它才知道该去哪儿找。所以它不能跟着 `remoteDir` 走。
 */
export const POINTER_DIR = DEFAULT_REMOTE_DIR

/** 「已存在」类错误码，用于建目录的幂等处理。 */
const ALREADY_EXISTS = new Set([-8, -7])
/** 「不存在」类错误码，用于删除的幂等处理。 */
const NOT_FOUND = new Set([-9, -10])

/**
 * 传输层错误。`code` 是网盘 errno（网络层错误则为字符串），message 已脱敏。
 */
export class BaiduError extends Error {
  /**
   * @param {string} message 已脱敏的说明。
   * @param {{ code?: number|string, step?: string, retryable?: boolean }} [detail] 附加信息。
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'BaiduError'
    this.code = detail.code ?? null
    this.step = detail.step ?? null
    this.retryable = detail.retryable === true
  }
}

/**
 * 把 token 从任意文本里抹掉。日志与错误信息都必须先过这一层。
 * @param {string} text 原始文本。
 * @param {string} token 当前 token。
 * @returns {string} 脱敏文本。
 */
export function redactToken(text, token) {
  let output = String(text)
  if (token) output = output.replaceAll(token, '***')
  return output.replace(/(access_token=)[^&\s"']+/g, '$1***')
}

/** 这个 errno 是否表示「已存在」。 */
export const isAlreadyExists = errno => ALREADY_EXISTS.has(Number(errno))
/** 这个 errno 是否表示「不存在」。 */
export const isNotFound = errno => NOT_FOUND.has(Number(errno))

/** 统一判断响应是否成功：errno 缺失视为成功（分片上传就是这样）。 */
function isOk(body) {
  if (body === null || typeof body !== 'object') return false
  const errno = body.errno
  if (errno === undefined || errno === null) return true
  return Number(errno) === 0
}

/** 从响应里取 errno，缺失返回 null。 */
const errnoOf = body => (body?.errno === undefined ? null : Number(body.errno))

/**
 * 建一个网盘传输器。
 *
 * @param {{
 *   token: string,
 *   remoteDir?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   retries?: number,
 *   onWarn?: (message: string) => void,
 * }} options 传输器配置。
 * @returns {object} 传输器实例。
 */
export function createBaiduTransport(options) {
  const token = options.token
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BaiduError('缺少网盘 access token', { step: 'init' })
  }
  const remoteDir = (options.remoteDir ?? DEFAULT_REMOTE_DIR).replace(/\/+$/, '')
  /**
   * 迁移目标目录时必须为真：否则目标 transport 会去读旧指针，把 replicasDir 解析回
   * **旧目录**，于是副本被写回旧目录、「读回核对」也照样通过（读的正是刚写进去的
   * 那一份），最后指针却被切到新目录——数据等于没搬。这是这条流程里最容易踩的坑。
   */
  const ignorePointer = options.ignorePointer === true
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const retries = Math.max(0, options.retries ?? 3)
  const onWarn = options.onWarn ?? (() => {})
  /** 写进 location.json 的 schema 版本；由同步层传入，避免两处各写一个数。 */
  const schemaVersion = Number.isInteger(options.schemaVersion) ? options.schemaVersion : 1
  /** 副本目录；若 location.json 指定了别处，会在 ensureDirs 时改写。 */
  let replicasDir = `${remoteDir}/${REPLICAS_SUBDIR}`
  let dirsReady = false

  /** 拼 URL —— token 只在这里进入请求。 */
  const apiUrl = (base, pathname, params) => {
    const url = new URL(pathname, base)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
    url.searchParams.set('access_token', token)
    return url
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * 带退避重试的请求。只重试网络错误、超时、5xx、429 —— 网盘业务错误码不重试，
   * 重试也没用而且会放大问题。
   */
  async function request(url, init = {}) {
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
        if (response.status === 429 || response.status >= 500) {
          lastError = new BaiduError(`HTTP ${response.status}`, { code: response.status, retryable: true })
        } else {
          return response
        }
      } catch (error) {
        const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? String(error))
        lastError = new BaiduError(redactToken(reason, token), { retryable: true })
      }
      if (attempt < retries) await delay(400 * 2 ** attempt)
    }
    throw lastError ?? new BaiduError('请求失败', { retryable: true })
  }

  /** POST 表单。 */
  async function postForm(pathname, query, body) {
    const response = await request(apiUrl(API_BASE, pathname, query), {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new BaiduError(`响应不是 JSON：${redactToken(text, token).slice(0, 120)}`, { step: pathname })
    }
  }

  /** GET JSON。 */
  async function getJson(pathname, query) {
    const response = await request(apiUrl(API_BASE, pathname, query), { headers: { 'User-Agent': USER_AGENT } })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new BaiduError(`响应不是 JSON：${redactToken(text, token).slice(0, 120)}`, { step: pathname })
    }
  }

  /** 列出某个目录，返回简化条目。 */
  async function listDir(dir) {
    const body = await getJson('/rest/2.0/xpan/file', {
      method: 'list', dir, order: 'time', start: '0', limit: '1000',
    })
    const errno = errnoOf(body)
    // 目录还不存在时，网盘返回「不存在」；对调用方等价于空目录。
    if (errno !== null && errno !== 0) {
      if (isNotFound(errno)) return []
      throw new BaiduError(`列目录失败 errno=${errno}`, { code: errno, step: 'list' })
    }
    return (body.list ?? []).map(item => ({
      name: String(item.server_filename),
      path: String(item.path ?? ''),
      fsId: item.fs_id,
      size: Number(item.size ?? 0),
      // 注意：这个字段不是内容 md5（见文件头第 6 条），只作诊断展示，不可用于校验。
      md5: typeof item.md5 === 'string' ? item.md5 : null,
      isDir: item.isdir === 1,
      mtime: Number(item.server_mtime ?? 0),
    }))
  }

  /** 建目录，幂等。rtype 必须是 0：rtype=1 会生成重名副本目录。 */
  async function mkdir(dir) {
    const body = await postForm('/rest/2.0/xpan/file', { method: 'create' }, {
      path: dir, isdir: '1', rtype: '0',
    })
    const errno = errnoOf(body)
    if (errno === null || errno === 0) return { created: true, errno }
    if (isAlreadyExists(errno)) return { created: false, errno }
    throw new BaiduError(`建目录失败 ${dir} errno=${errno}`, { code: errno, step: 'mkdir' })
  }

  /**
   * 确保云端目录就绪。逐级建目录（网盘不建父目录），并读取 location.json
   * 以支持「云端目录被移动过」的情况。
   */
  async function ensureDirs() {
    if (dirsReady) return replicasDir
    const segments = remoteDir.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      await mkdir(current)
    }
    // 指针固定放在 POINTER_DIR：自定义目录时它可能还没建过，得顺手建出来，
    // 否则写指针会失败——那样别的设备就永远发现不了搬走的目录。
    if (POINTER_DIR !== remoteDir) {
      const pointerSegments = POINTER_DIR.split('/').filter(Boolean)
      let walkedPointer = ''
      for (const segment of pointerSegments) {
        walkedPointer += `/${segment}`
        await mkdir(walkedPointer)
      }
    }
    // location.json 只是「目录指针」：读到就沿用，读失败不影响使用，只记一条告警。
    // ignorePointer（迁移目标 transport）下完全不碰指针：读它会把 replicasDir 解析回
    // 旧目录，写它又会在核对通过之前就把别的设备指到还没铺好数据的新目录。
    let pointer = null
    if (!ignorePointer) {
      try {
        const raw = await readRaw(`${POINTER_DIR}/${LOCATION_FILE}`)
        if (raw !== null) pointer = JSON.parse(raw.toString('utf8'))
      } catch (error) {
        onWarn(`读取目录指针失败，沿用默认目录：${error?.message ?? error}`)
      }
    }
    if (ignorePointer) {
      /* 迁移目标：只用 remoteDir 推导出来的目录，指针由迁移流程最后显式写。 */
    } else if (pointer !== null && typeof pointer?.replicasDir === 'string' && pointer.replicasDir.startsWith('/')) {
      replicasDir = pointer.replicasDir.replace(/\/+$/, '')
    } else if (pointer === null) {
      // 第一次使用这个目录：把指针写下来，声明副本目录与 schema 版本。
      // 只在缺失时写（已有指针绝不覆盖），并且直接调 writeRaw —— 走公开的
      // writeLocation 会再进一次 ensureDirs，dirsReady 还是 false，会无限递归。
      try {
        await writeRaw(`${POINTER_DIR}/${LOCATION_FILE}`, Buffer.from(JSON.stringify({
          schemaVersion,
          replicasDir,
          createdAt: new Date().toISOString(),
        }, null, 2), 'utf8'))
      } catch (error) {
        onWarn(`写目录指针失败（不影响同步）：${error?.message ?? error}`)
      }
    }
    const replicasSegments = replicasDir.split('/').filter(Boolean)
    let walked = ''
    for (const segment of replicasSegments) {
      walked += `/${segment}`
      await mkdir(walked)
    }
    dirsReady = true
    return replicasDir
  }

  /**
   * 按**文件名**取当前文件内容。刻意每次重新列目录：覆盖面写会换 fs_id，
   * 缓存 fs_id 会读到过期内容。
   * @param {string} path 绝对路径。
   * @returns {Promise<Buffer|null>} 文件内容；不存在返回 null。
   */
  async function readRaw(path) {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    const name = path.slice(path.lastIndexOf('/') + 1)
    const entry = (await listDir(dir)).find(item => item.name === name)
    if (entry === undefined) return null
    if (entry.size > MAX_REMOTE_BYTES) {
      throw new BaiduError(`远端文件超过上限（${entry.size} 字节）`, { step: 'read' })
    }
    const meta = await getJson('/rest/2.0/xpan/multimedia', {
      method: 'filemetas', fsids: JSON.stringify([entry.fsId]), dlink: '1',
    })
    const errno = errnoOf(meta)
    if (errno !== null && errno !== 0) {
      throw new BaiduError(`取下载地址失败 errno=${errno}`, { code: errno, step: 'filemetas' })
    }
    const file = (meta.list ?? [])[0]
    if (typeof file?.dlink !== 'string' || file.dlink === '') {
      throw new BaiduError('下载地址为空', { step: 'filemetas' })
    }
    const dlink = new URL(file.dlink)
    if (!dlink.searchParams.has('access_token')) dlink.searchParams.set('access_token', token)
    const response = await request(dlink, { headers: { 'User-Agent': USER_AGENT } })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_REMOTE_BYTES) {
      throw new BaiduError(`远端文件超过上限（${buffer.length} 字节）`, { step: 'read' })
    }
    // 用「字节数一致」做完整性校验。
    //
    // 刻意不比对 list/create 返回的 `md5` 字段：实测那个字段不是内容 md5。
    // 同一个 81 字节文件，本地 md5 是 36e9c489…，而网盘返回
    // a1d1adf8bv4209664168a63676f489e1 —— 含字母 v，根本不是十六进制，
    // 是网盘自己的签名。拿它比对会把每一次正常下载都判成损坏。
    // 真正能拦住损坏/截断的是字节数 + 上层的严格 schema 校验。
    if (entry.size > 0 && buffer.length !== entry.size) {
      throw new BaiduError(
        `下载字节数与列目录不符（列出 ${entry.size}，实收 ${buffer.length}）`,
        { step: 'read' },
      )
    }
    return buffer
  }

  /**
   * 按路径删除，幂等。
   *
   * 是否「真的删掉了」靠**删除前先列目录**判断，而不是解析删除响应：实测删一个
   * 不存在的文件时，网盘返回的形状无法区分「删掉了」和「本来就没有」（会给出
   * 空的 info 列表），照它判断会谎报成功。多一次列目录换取判断可靠，值得。
   *
   * @param {string} path 绝对路径。
   * @returns {Promise<{removed: boolean}>} 是否真的删掉了。
   */
  async function removeRaw(path) {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    const name = path.slice(path.lastIndexOf('/') + 1)
    const existed = (await listDir(dir)).some(item => item.name === name)
    if (!existed) return { removed: false }

    const body = await postForm(
      '/rest/2.0/xpan/file',
      { method: 'filemanager', opera: 'delete', openapi: 'xpansdk' },
      { async: '0', filelist: JSON.stringify([path]) },
    )
    const errno = errnoOf(body)
    const perFile = body.info?.[0]?.errno === undefined ? null : Number(body.info[0].errno)
    // 目录/文件不存在不算失败：删除是幂等的。
    if (perFile !== null && isNotFound(perFile)) return { removed: false }
    if (errno !== null && errno !== 0 && !isNotFound(errno)) {
      throw new BaiduError(`删除失败 errno=${errno}`, { code: errno, step: 'delete' })
    }
    if (perFile !== null && perFile !== 0) {
      throw new BaiduError(`删除失败 per-file errno=${perFile}`, { code: perFile, step: 'delete' })
    }
    return { removed: true }
  }

  /**
   * 写入一个文件。
   *
   * 刻意「先删再传」而不是依赖 rtype=2 覆盖：实测 rtype=2 会生成 `name(1).json`，
   * 原文件不动，于是按名字读回来的永远是第一版。代价是删除到重建之间有一个很短
   * 的空窗；但每个设备只写自己那一份副本，其他设备读到的只是「该设备暂时没有副本」，
   * 不会读到坏数据，而且本机账本始终是完整的、失败会重试。
   *
   * @param {string} path 绝对路径。
   * @param {Buffer} buffer 内容，不得超过 1 MiB。
   * @returns {Promise<{fsId: unknown, size: number, replaced: boolean}>} 写入结果。
   */
  async function writeRaw(path, buffer) {
    if (buffer.length > MAX_REMOTE_BYTES) {
      throw new BaiduError(`本地内容超过上限（${buffer.length} 字节）`, { step: 'write' })
    }
    const md5 = createHash('md5').update(buffer).digest('hex')
    const { removed } = await removeRaw(path)

    const precreate = await postForm('/rest/2.0/xpan/file', { method: 'precreate' }, {
      path,
      size: String(buffer.length),
      isdir: '0',
      autoinit: '1',
      // 0 = 不重命名，冲突时报错。我们刚删过，理论上不会冲突。
      rtype: '0',
      block_list: JSON.stringify([md5]),
    })
    const preErrno = errnoOf(precreate)
    if (preErrno !== null && preErrno !== 0) {
      throw new BaiduError(`预创建失败 errno=${preErrno}`, { code: preErrno, step: 'precreate' })
    }

    let serverMd5 = md5
    const uploadId = typeof precreate.uploadid === 'string' ? precreate.uploadid : ''
    if (Number(precreate.return_type) !== 2 && uploadId !== '') {
      const form = new FormData()
      form.set('file', new Blob([buffer]), 'file')
      const response = await request(
        apiUrl(PCS_BASE, '/rest/2.0/pcs/superfile2', {
          method: 'upload', type: 'tmpfile', path, uploadid: uploadId, partseq: '0',
        }),
        { method: 'POST', headers: { 'User-Agent': USER_AGENT }, body: form },
      )
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new BaiduError(`分片响应不是 JSON：${redactToken(text, token).slice(0, 120)}`, { step: 'superfile2' })
      }
      // 成功时不带 errno 字段，所以只在 errno 存在且非 0 时才算失败。
      if (!isOk(body)) {
        throw new BaiduError(`分片上传失败 errno=${errnoOf(body)}`, { code: errnoOf(body), step: 'superfile2' })
      }
      if (typeof body.md5 === 'string' && body.md5 !== '') serverMd5 = body.md5.toLowerCase()
    }

    const create = await postForm('/rest/2.0/xpan/file', { method: 'create' }, {
      path,
      size: String(buffer.length),
      uploadid: uploadId,
      isdir: '0',
      rtype: '0',
      block_list: JSON.stringify([serverMd5]),
    })
    const createErrno = errnoOf(create)
    if (createErrno !== null && createErrno !== 0) {
      throw new BaiduError(`合并文件失败 errno=${createErrno}`, { code: createErrno, step: 'create' })
    }
    // 落盘路径必须与请求一致：若网盘又给了 `(1)` 后缀，说明覆盖语义被破坏，宁可报错。
    if (typeof create.path === 'string' && create.path !== path) {
      throw new BaiduError(`网盘改写了目标路径（${create.path}），拒绝静默接受副本`, { step: 'create' })
    }
    return { fsId: create.fs_id ?? null, size: Number(create.size ?? buffer.length), replaced: removed }
  }

  return {
    remoteDir,
    /** 当前生效的副本目录（location.json 可能改写过它）。 */
    get replicasDir() {
      return replicasDir
    },
    ensureDirs,
    /** 列出所有设备副本文件。 */
    async listReplicas() {
      await ensureDirs()
      return (await listDir(replicasDir)).filter(item => !item.isDir)
    },
    /** 读某个设备副本。 */
    async readReplica(name) {
      await ensureDirs()
      return readRaw(`${replicasDir}/${name}`)
    },
    /** 写某个设备副本。 */
    async writeReplica(name, buffer) {
      await ensureDirs()
      return writeRaw(`${replicasDir}/${name}`, buffer)
    },
    /** 删某个设备副本（幂等）。 */
    async deleteReplica(name) {
      await ensureDirs()
      return removeRaw(`${replicasDir}/${name}`)
    },
    /**
     * 删除远端任意路径（文件或目录），幂等。
     *
     * 副本之外的清理都要靠它：测试收尾要能把自己建出来的目录整个抹掉，
     * 将来做「忘记这台设备」也要能删掉对应的那一份副本加目录。
     * @param {string} path 绝对云端路径（以 `/` 开头）。
     * @returns {Promise<{removed: boolean}>} 是否确实删除过。
     */
    async deletePath(path) {
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new BaiduError(`删除路径必须以 / 开头：${path}`, { step: 'deletePath' })
      }
      return removeRaw(path)
    },
    /**
     * 测试云端目录能不能读写：写一个探针文件、逐字节读回核对、再删掉。
     *
     * 对应方案里的「测试读写」。名字带时间戳与随机段，避免两台设备同时测时撞名；
     * 无论成功失败都**尽力删除**，不在用户网盘里留垃圾。刻意不抛异常：
     * 失败原因要能显示在设置页上，而不是变成一个找不到出处的报错。
     * @returns {Promise<{ ok: boolean, dir: string, bytes: number, readBack: boolean, removed: boolean, error: string|null }>} 结果。
     */
    async probe() {
      const path = `${remoteDir}/.write-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`
      const body = Buffer.from(JSON.stringify({ probe: true, at: new Date().toISOString() }), 'utf8')
      let bytes = 0
      let readBack = false
      let removed = false
      let error = null
      try {
        await ensureDirs()
        const written = await writeRaw(path, body)
        bytes = Number(written?.size ?? body.length)
        const back = await readRaw(path)
        // 逐字节核对：能读到但内容不同，等于这个目录不可信。
        readBack = back !== null && back.equals(body)
        if (!readBack && error === null) error = '写进去了，但读回来的内容与写入的不一致（该目录不可信）'
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      } finally {
        try {
          const deletion = await removeRaw(path)
          removed = deletion?.removed === true
        } catch (caught) {
          const message = `探针文件删除失败：${caught instanceof Error ? caught.message : String(caught)}`
          error = error === null ? message : `${error}；${message}`
        }
      }
      return { ok: error === null && readBack, dir: remoteDir, bytes, readBack, removed, error }
    },
    /** 写目录指针。 */
    async writeLocation(pointer) {
      await ensureDirs()
      return writeRaw(`${POINTER_DIR}/${LOCATION_FILE}`, Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'))
    },
    /** 读目录指针，不存在返回 null。 */
    async readLocation() {
      try {
        const buffer = await readRaw(`${POINTER_DIR}/${LOCATION_FILE}`)
        return buffer === null ? null : JSON.parse(buffer.toString('utf8'))
      } catch {
        return null
      }
    },
    /** 列出云端根目录，供界面选择同步目录。 */
    async listRoot() {
      return listDir('/')
    },
    /**
     * 读网盘账号信息。
     *
     * `uk` 是账号的稳定标识，本插件用它做**本地缓存的命名空间**：同一台电脑上
     * 换一个网盘账号，绝不能让上一个账号的远端视图与新账号的数据混在一起。
     * @returns {Promise<{uk: string|null, baiduName: string|null, netdiskName: string|null, vipType: number|null}>} 账号信息。
     */
    async getAccount() {
      const body = await getJson('/rest/2.0/xpan/nas', { method: 'uinfo' })
      const errno = errnoOf(body)
      if (errno !== null && errno !== 0) {
        throw new BaiduError(`读取网盘账号失败 errno=${errno}`, { code: errno, step: 'uinfo' })
      }
      return {
        uk: body.uk === undefined || body.uk === null ? null : String(body.uk),
        baiduName: typeof body.baidu_name === 'string' ? body.baidu_name : null,
        netdiskName: typeof body.netdisk_name === 'string' ? body.netdisk_name : null,
        vipType: body.vip_type === undefined ? null : Number(body.vip_type),
      }
    },
  }
}
