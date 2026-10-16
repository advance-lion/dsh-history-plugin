/**
 * 凭据层：把百度网盘的 access/refresh token 放进 DSH Host 的安全存储。
 *
 * 为什么必须走 Host 安全存储而不是自己写文件：token 一旦落进本插件的数据目录，
 * 就会跟着账本一起进云、进备份、进日志。这里只使用 DSH 提供的凭据服务，本插件
 * 自己不写任何 token 文件。
 *
 * 两个实现细节来自读官方实现（`@deepseek-ai/dsh-credentials`）：
 *
 *  1. 记录（record）的键是 `<scope>/<id>`，两端都必须匹配
 *     `/^[a-z][a-z0-9-]*$/`。我们用的是 `dsh-history-plugin/baidu-netdisk`。
 *  2. `credentialKey()` 只是**类型品牌**，运行时会被擦除。而本插件刻意零依赖，
 *     从 `link:` 目录解析不到 `@deepseek-ai/dsh-credentials`，所以这里传等价字符串，
 *     并自己按同一条正则校验，避免写进一个非法键。若能解析到官方构造函数就用它。
 *
 * 记录用 `kind: 'grant'`：按官方文档，只有拥有它的插件能解释 payload，别的插件
 * 拿不到也读不懂。写入只走 `modifyRecord`——它是唯一的写路径，且在支持独占的
 * 存储上跨进程成立，正好满足「刷新 token 是读—决定—替换」的需求。
 */

/** 记录键的 scope 段。 */
export const CREDENTIAL_SCOPE = 'dsh-history-plugin'
/** 记录键的 id 段。 */
export const CREDENTIAL_ID = 'baidu-netdisk'
/** 完整的记录键。 */
export const CREDENTIAL_KEY = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`
/** 开发/自部署用：直接提供 access token，免得非要把 token 粘进配置。 */
export const ENV_ACCESS_TOKEN = 'BAIDU_ACCESS_TOKEN'
/** 开发/自部署用：refresh token。 */
export const ENV_REFRESH_TOKEN = 'BAIDU_REFRESH_TOKEN'
/** 开发/自部署用：无网盘凭据服务时，把 token 落到这个文件（仅用于无人值守环境）。 */
export const ENV_TOKEN_FILE = 'DSH_HISTORY_BAIDU_TOKEN_FILE'

/** 与官方实现一致的键段正则。 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 校验一个键段是否合法。
 * @param {string} segment 键段。
 * @returns {boolean} 是否合法。
 */
export const isCredentialKeySegment = segment =>
  typeof segment === 'string' && KEY_SEGMENT_PATTERN.test(segment)

/**
 * 若本机解析不到官方品牌构造函数，就用等价字符串。
 * 品牌在运行时被擦除，字符串只要满足官方正则即等价。
 * @returns {Promise<(scope: string, id: string) => string>} 构造函数。
 */
async function loadBrandConstructor() {
  try {
    const mod = await import('@deepseek-ai/dsh-credentials')
    if (typeof mod?.credentialKey === 'function') return mod.credentialKey
  } catch {
    /* 解析不到就用字符串，这是预期内的正常路径。 */
  }
  return (scope, id) => {
    if (!isCredentialKeySegment(scope) || !isCredentialKeySegment(id)) {
      throw new TypeError(`凭据键段不合法："${scope}/${id}" 的两段都必须匹配 ${String(KEY_SEGMENT_PATTERN)}`)
    }
    return `${scope}/${id}`
  }
}

/**
 * 把 grant 里的字段收敛成稳定形状，顺便丢掉任何多余字段。
 * 强调：返回值含密钥，**绝不可**进入日志或历史文件。
 * @param {unknown} payload 记录里的 payload。
 * @returns {object|null} 归一化后的 grant。
 */
function normalizeGrant(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const value = /** @type {Record<string, unknown>} */ (payload)
  const accessToken = typeof value.accessToken === 'string' ? value.accessToken : ''
  if (accessToken === '') return null
  return {
    accessToken,
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
    /** 绝对毫秒时间戳；null 表示不知道（百度的部分 token 不过期）。 */
    expiresAt: Number.isFinite(value.expiresAt) ? Number(value.expiresAt) : null,
    /** 网盘账号标识，用于隔离本地缓存。 */
    uk: typeof value.uk === 'string' ? value.uk : null,
    baiduName: typeof value.baiduName === 'string' ? value.baiduName : null,
    /** 授权范围，日后换正式应用时用来判断是否需要重新授权。 */
    scope: typeof value.scope === 'string' ? value.scope : null,
    /**
     * 开放平台应用的凭据。放在这里而不是插件配置里：插件配置是 profile 下的
     * 明文文件，而这里是 DSH 指定的密钥存储。有它才能自动刷新 token。
     */
    appKey: typeof value.appKey === 'string' && value.appKey !== '' ? value.appKey : null,
    secretKey: typeof value.secretKey === 'string' && value.secretKey !== '' ? value.secretKey : null,
    /** 授权时用的回调地址，必须与开放平台登记的一致，刷新与重授权都要用它。 */
    redirectUri: typeof value.redirectUri === 'string' && value.redirectUri !== '' ? value.redirectUri : null,
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
  }
}

/**
 * 建立一个 grant 存取器。
 *
 * @param {() => unknown} getCredentials 返回凭据服务（可能尚未挂载），每次都重新取。
 * @param {{ getEnv?: () => Record<string, string|undefined>, readTokenFile?: (path: string) => string|null, onWarn?: (message: string) => void }} [options] 环境。
 * @returns {object} 存取器。
 */
export function createGrantStore(getCredentials, options = {}) {
  const getEnv = options.getEnv ?? (() => process.env)
  const readTokenFile = options.readTokenFile ?? (() => null)
  const onWarn = options.onWarn ?? (() => {})
  /** @type {(scope: string, id: string) => string} */
  let brand = (scope, id) => `${scope}/${id}`
  let brandReady = null

  /** 惰性解析品牌构造函数，只做一次。 */
  async function key() {
    if (brandReady === null) brandReady = loadBrandConstructor()
    brand = await brandReady
    return brand(CREDENTIAL_SCOPE, CREDENTIAL_ID)
  }

  /** 取凭据服务；不可用返回 null（而不是抛错——没有它本机记账照样能用）。 */
  function service() {
    const value = getCredentials()
    return value !== null && typeof value === 'object' ? value : null
  }

  /**
   * 从环境变量/文件读一个开发用 token。这些路径不写盘、不进云，只为本机联调。
   * @returns {object|null} grant。
   */
  function readFallback() {
    const env = getEnv()
    const inline = env[ENV_ACCESS_TOKEN]
    if (typeof inline === 'string' && inline.trim() !== '') {
      return {
        grant: normalizeGrant({
          accessToken: inline.trim(),
          refreshToken: env[ENV_REFRESH_TOKEN] ?? null,
          savedAt: null,
        }),
        source: 'env',
      }
    }
    const file = env[ENV_TOKEN_FILE]
    if (typeof file === 'string' && file.trim() !== '') {
      const content = readTokenFile(file.trim())
      if (typeof content === 'string' && content.trim() !== '') {
        return { grant: normalizeGrant({ accessToken: content.trim(), savedAt: null }), source: 'token-file' }
      }
    }
    return null
  }

  return {
    key,
    /** 凭据服务是否可用。 */
    available() {
      return service() !== null
    },
    /**
     * 读当前授权。
     * @returns {Promise<{ grant: object, source: string }|null>} 授权与其来源。
     */
    async read() {
      const credentials = service()
      if (credentials !== null && typeof credentials.readRecord === 'function') {
        try {
          const record = await credentials.readRecord(await key())
          if (record !== null && typeof record === 'object' && record.kind === 'grant') {
            const grant = normalizeGrant(record.payload)
            if (grant !== null) return { grant, source: 'credentials' }
          }
        } catch (error) {
          onWarn(`读取凭据记录失败：${error?.message ?? error}`)
        }
      }
      // 安全存储里没有（或服务不可用）时，才看开发用的环境变量。
      return readFallback()
    },
    /**
     * 写入或替换授权。只走 `modifyRecord`：官方文档指定它是唯一写路径。
     *
     * 应用配置（AppKey/SecretKey/回调地址）**合并**而不是覆盖：粘贴一个临时
     * token 不该把已经配好的应用凭据抹掉，否则自动刷新会莫名其妙失效。
     * 会话字段（token/过期时间/账号）则以调用方为准——重授权换了账号时，
     * 留着上一个账号的 uk 会把本地缓存的命名空间指错。
     * @param {object} grant 授权内容（含密钥，调用方不得记录它）。
     * @returns {Promise<{ written: boolean, source: string }>} 写入结果。
     */
    async write(grant) {
      const credentials = service()
      if (credentials === null || typeof credentials.modifyRecord !== 'function') {
        return { written: false, source: 'unavailable' }
      }
      await credentials.modifyRecord(await key(), async current => {
        const existing = current !== null && typeof current === 'object' && current.kind === 'grant'
          ? normalizeGrant(current.payload)
          : null
        const payload = {
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken ?? null,
          expiresAt: grant.expiresAt ?? null,
          uk: grant.uk ?? null,
          baiduName: grant.baiduName ?? null,
          scope: grant.scope ?? null,
          appKey: grant.appKey ?? existing?.appKey ?? null,
          secretKey: grant.secretKey ?? existing?.secretKey ?? null,
          redirectUri: grant.redirectUri ?? existing?.redirectUri ?? null,
          savedAt: new Date().toISOString(),
        }
        return { kind: 'grant', payload }
      })
      return { written: true, source: 'credentials' }
    },
    /**
     * 移除授权。
     * @returns {Promise<void>} 完成。
     */
    async clear() {
      const credentials = service()
      if (credentials === null || typeof credentials.deleteRecord !== 'function') return
      await credentials.deleteRecord(await key())
    },
    /**
     * 读取「是否已授权」这类对界面安全的信息——**不返回密钥本身**。
     * @returns {Promise<{ configured: boolean, writable: boolean|null, source: string|null }>} 状态。
     */
    async describe() {
      const credentials = service()
      if (credentials !== null && typeof credentials.describeRecord === 'function') {
        try {
          const info = await credentials.describeRecord(await key())
          if (info?.configured === true) {
            return { configured: true, writable: info.writable ?? null, source: 'credentials' }
          }
        } catch (error) {
          onWarn(`查询凭据状态失败：${error?.message ?? error}`)
        }
      }
      const fallback = readFallback()
      if (fallback !== null) return { configured: true, writable: false, source: fallback.source }
      return { configured: false, writable: credentials !== null, source: null }
    },
  }
}
