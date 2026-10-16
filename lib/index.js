/**
 * dsh-history-plugin · 宿主半边入口
 *
 * 装配顺序与理由：
 *
 *  - **采集是底线能力。** `pluginManager` 缺席时本机记账仍然要能跑，所以用
 *    `ctx.inject([...])` 延迟接入，而不是写进 `inject` 数组——写进去会让整个插件
 *    在服务缺席时不激活，那样连本机记账都没了。
 *  - **同步是可选能力。** 没有百度网盘授权、甚至没有凭据服务时，本机账本照常工作，
 *    只是不跨设备。所有云路径都在读了授权之后才走。
 *  - **HTTP 接口独立接入 `webServer`。** 界面需要的读写在客户端半边，走宿主自己的
 *    请求闸（见 http.js：不过闸等于没认证）。
 *
 * 一个必须记住的事实：`plugin-manager/changed` 的载荷只有 `{ reason }`，**不带 diff**。
 * 所以每次收到都只能回读 `listBundles()` 重新核对，不能指望事件告诉我们装了什么。
 */

import { DEMO_REDIRECT_URI, createAuthSessions, extractToken, implicitGrant } from './authflow.js'
import { createBaiduTransport } from './baidu.js'
import { createCollector, resolveProfileDir } from './collector.js'
import { createGrantStore } from './credentials.js'
import { API_PREFIX, createHttpApi } from './http.js'
import { createReinstaller } from './install.js'
import { DEFAULT_SCOPE, buildAuthorizeUrl, createTokenKeeper, exchangeCode } from './oauth.js'
import { aggregateByPackage, loadDevice, loadHistory, setDeviceLabel } from './store.js'
import { createSync } from './sync.js'
import { SCHEMA_VERSION, clipString, logEvent, newId, sweepTempFiles } from './util.js'
import { hostname } from 'node:os'

/**
 * 本机设备显示名：用户没起名字时就用**系统设备名**（Windows 的「设备名称」就是它，
 * 例如 LAPTOP-IM8QO56E），这样新设备一装上就能在跨设备历史里被认出来，不用手填。
 * @returns {string|null} 显示名。
 */
function effectiveLabel() {
  const stored = loadDevice().deviceLabel
  if (typeof stored === 'string' && stored.trim() !== '') return stored.trim()
  try {
    return hostname() || null
  } catch {
    return null
  }
}

/** 插件行名；与 cordis.patch.yml 的 id 无关，仅用于诊断。 */
export const name = 'history-plugin'

/** 宿主侧依赖：空数组表示不等待任何服务即可启动。 */
export const inject = []

/** 配置默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 云端的同步目录。 */
  remoteDir: '/dsh-history-plugin',
  /** 安装后自动推送（防抖）与启动时自动拉取。 */
  autoSync: true,
  pullOnStart: true,
})

/** 每次响应最多带多少条明细，避免一次把整本账本推给浏览器。 */
const WIRE_ENTRY_LIMIT = 50

/**
 * 收敛配置。任何非法值都退回默认值，绝不让一个手写错的配置把插件带崩。
 * @param {unknown} raw 原始配置。
 * @returns {{ remoteDir: string, autoSync: boolean, pullOnStart: boolean }} 收敛后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const rawDir = typeof source.remoteDir === 'string' ? source.remoteDir.trim() : ''
  // 必须是绝对路径：百度网盘的目录以 `/` 开头，相对路径会被服务端悄悄建成别的目录。
  const trimmed = rawDir.replace(/\/+$/, '')
  // 目录是用户手输的，按不可信输入对待：`..` / `.` 段是路径穿越，NUL 与超长串一律拒绝。
  // 拒绝的方式是退回默认目录，而不是抛错——一个写错的配置不该让插件起不来。
  const segments = trimmed.split('/').filter(segment => segment !== '')
  const unsafe = rawDir.includes('\u0000')
    || rawDir.length > 512
    || segments.includes('..')
    || segments.includes('.')
  const remoteDir = rawDir.startsWith('/') && trimmed !== '' && trimmed !== '/dsh-history-plugin/v1' && !unsafe
    ? trimmed
    : DEFAULT_CONFIG.remoteDir
  return {
    remoteDir,
    autoSync: source.autoSync !== false,
    pullOnStart: source.pullOnStart !== false,
  }
}

/**
 * 把一条事件裁成给界面用的形状。
 * @param {object} entry 事件。
 * @returns {object} 精简后的事件。
 */
function wireEntry(entry) {
  return {
    eventId: entry.eventId,
    kind: entry.kind,
    packageName: entry.packageName,
    version: entry.version ?? null,
    installSpec: entry.installSpec ?? null,
    sourceType: entry.sourceType ?? null,
    installedAt: entry.installedAt ?? null,
    observedAt: entry.observedAt ?? null,
    deviceId: entry.deviceId ?? null,
    provenance: entry.provenance ?? null,
  }
}

/**
 * 把一行裁成给界面用的形状。
 * @param {object} row 合并行。
 * @returns {object} 精简后的行。
 */
function wireRow(row) {
  return {
    key: row.key,
    packageName: row.packageName,
    entryCount: row.entryCount,
    versions: row.versions,
    latestAt: row.latestAt,
    lastInstalledAt: row.lastInstalledAt,
    deviceCount: row.deviceCount,
    devices: row.devices,
    installSpec: row.installSpec ?? null,
    sourceType: row.sourceType ?? null,
    reinstallable: row.reinstallable,
    present: row.present,
    presentVersion: row.presentVersion ?? null,
    entriesTruncated: row.entries.length > WIRE_ENTRY_LIMIT,
    entries: row.entries.slice(0, WIRE_ENTRY_LIMIT).map(wireEntry),
  }
}

/**
 * 宿主侧入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {unknown} [config] 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const onWarn = message => logEvent('warn', 'warn', message)
  // 凭据服务可能尚未挂载：每次现取，取不到就退回开发用环境变量。
  const grants = createGrantStore(() => ctx.get('credentials'), { onWarn })

  // 启动清扫：上一次若被 kill 在「写临时文件」与「rename」之间，会留下 `.tmp-<pid>`。
  // 只删属于已死进程的那些（判活见 sweepTempFiles 的说明），不留垃圾也不误删他人。
  const swept = sweepTempFiles()
  if (swept.removed > 0) logEvent('info', 'temp-sweep', `cleaned ${swept.removed} stale temp file(s): ${swept.names.join(', ')}`)

  /** 最近一次读到的授权；`getAppKeys` 要用它（见下面 readGrant 的说明）。 */
  let lastGrant = null
  /**
   * token 保管者：同步前确保授权可用，快过期就用 refresh_token 换新的。
   *
   * `getAppKeys` 只能同步返回，而应用凭据（AppKey/SecretKey）与授权存在同一条凭据
   * 记录里，所以让 `readGrant` 顺手把结果记在 `lastGrant` 上——`ensureFresh()` 内部
   * 总是先 `await readGrant()` 再问 `getAppKeys()`，这个顺序是稳定的。
   */
  // 一键授权的一次性会话（内存态，不落盘）：state 对不上或过期就一律不认。
  const authSessions = createAuthSessions()
  const tokenKeeper = createTokenKeeper({
    readGrant: async () => {
      const current = await grants.read()
      lastGrant = current?.grant ?? null
      return current
    },
    writeGrant: grant => grants.write(grant),
    getAppKeys: () => ({ appKey: lastGrant?.appKey ?? null, secretKey: lastGrant?.secretKey ?? null }),
    // 只记可读原因：这里可能出现百度的 error_description，但不含任何密钥。
    onWarn: message => logEvent('warn', 'token-refresh', message),
  })
  const reinstaller = createReinstaller({ getManager: () => ctx.get('pluginManager'), log: logEvent })

  /** @type {ReturnType<typeof createCollector>|null} */
  let collector = null
  /** @type {ReturnType<typeof createSync>|null} */
  let engine = null

  /**
   * 合并视图；同步器还没起来时退回本机账本。
   * @returns {{ rows: object[], devices: object[], entries: number, deviceId: string, synced: boolean }} 视图。
   */
  function view() {
    if (engine !== null) {
      const merged = engine.mergedView()
      return {
        rows: merged.rows,
        devices: merged.devices,
        entries: merged.entries,
        deviceId: loadDevice().deviceId,
        deviceLabel: effectiveLabel(),
        // synced 说的是「这次合并里确实含云端副本」，而不是「同步器存在」——
        // 后者在没授权时也为真，会让界面谎报已同步。
        synced: engine.documents().length > 0,
      }
    }
    const local = loadHistory()
    return {
      rows: aggregateByPackage(local.entries),
      devices: [],
      entries: local.entries.length,
      deviceId: loadDevice().deviceId,
      deviceLabel: effectiveLabel(),
      synced: false,
    }
  }

  ctx.inject(['pluginManager'], hostCtx => {
    const profileDir = resolveProfileDir(hostCtx)
    collector = createCollector({
      // 请求时才查服务：让插件可以先挂载、服务后到；服务始终不来就自己降级。
      getManager: () => hostCtx.get('pluginManager'),
      profileDir,
    })
    engine = createSync({
      getGrant: () => grants.read(),
      getDevice: () => loadDevice(),
      getCurrent: () => collector?.currentPackages() ?? new Map(),
      config: settings,
      refreshTokens: () => tokenKeeper.ensureFresh(),
      onWarn,
    })

    hostCtx.effect(() => {
      const device = loadDevice()
      logEvent('info', 'collector-start', `device=${device.deviceId} profile=${profileDir ?? 'unresolved'}`)
      void collector?.start().then(() => {
        if (settings.pullOnStart) return engine?.pull()
        return undefined
      })

      const off = hostCtx.on('plugin-manager/changed', change => {
        const reason = change !== null && typeof change === 'object' && typeof change.reason === 'string'
          ? change.reason
          : 'changed'
        void collector?.reconcile(reason).then(() => engine?.schedule(reason))
      })

      return () => {
        if (typeof off === 'function') off()
        collector?.dispose()
        engine?.dispose()
        collector = null
        engine = null
      }
    }, 'dsh-history-plugin: install ledger collector')
  })

  ctx.inject(['webServer'], hostCtx => {
    /**
     * 打开历史页时补扫一次（节流 30 秒）。
     *
     * 方案要求「启动、重连、打开历史页时再扫描一次」：CLI 安装或手工改动不会发
     * `plugin-manager/changed`，只在启动时扫一次就可能一直漏到下次重启。节流是为了
     * 界面每次重渲染都触发一遍 profile 清单读取。
     */
    let lastViewScanAt = 0
    let viewScanInFlight = null
    const maybeScanOnView = async () => {
      if (collector === null) return
      if (viewScanInFlight !== null) return viewScanInFlight
      if (Date.now() - lastViewScanAt < 30_000) return
      lastViewScanAt = Date.now()
      viewScanInFlight = collector.reconcile('view')
        .catch(error => onWarn(`打开历史页时的补扫失败：${error?.message ?? error}`))
        .finally(() => {
          viewScanInFlight = null
        })
      return viewScanInFlight
    }

    const api = createHttpApi({
      getConnection: () => hostCtx.get('connection'),
      log: logEvent,
      handlers: {
        /** 状态：同步、凭据、设备。**不含 token**，凭据只报「是否已配置」。 */
        async status() {
          const device = loadDevice()
          // 设置页要显示「当前连的是哪个网盘账号」。**只取显示名**：uk 与任何 token
          // 都不进响应（凭据本身只报状态，见 credential 字段）。
          const grant = (await grants.read())?.grant ?? null
          const account = typeof grant?.baiduName === 'string' && grant.baiduName !== ''
            ? { netdiskName: grant.baiduName }
            : null
          return {
            api: { prefix: API_PREFIX, version: 1 },
            device,
            credential: await grants.describe(),
            account,
            sync: engine?.status() ?? { configured: false, remoteDir: settings.remoteDir, autoSync: settings.autoSync, devices: [], deviceCount: 0, pluginCount: 0, entryCount: 0 },
            config: settings,
          }
        },
        /** 跨设备合并后的历史。 */
        async history() {
          await maybeScanOnView()
          const merged = view()
          return {
            deviceId: merged.deviceId,
            synced: merged.synced,
            entryCount: merged.entries,
            devices: merged.devices,
            rows: merged.rows.map(wireRow),
          }
        },
        /** 只列设备，供界面显示「哪些机器有这个插件的记录」。 */
        async devices() {
          const merged = view()
          return { devices: merged.devices, deviceId: merged.deviceId }
        },
        /** 手动同步：拉取其它设备 + 推送本机。 */
        async sync() {
          if (engine === null) throw new Error('同步器未就绪（采集器尚未启动）')
          const result = await engine.sync({ force: true })
          return {
            pulled: result.pulled.ok === true
              ? { ok: true, deviceCount: result.pulled.devices.length, pluginCount: result.pulled.rows.length, skipped: result.pulled.skipped ?? [] }
              : { ok: false, reason: result.pulled.reason ?? 'failed', error: result.pulled.error ?? null },
            pushed: result.pushed.ok === true
              ? { ok: true, bytes: result.pushed.bytes ?? 0, entries: result.pushed.entries ?? 0, dropped: result.pushed.dropped ?? 0 }
              : { ok: false, reason: result.pushed.reason ?? 'failed', error: result.pushed.error ?? null },
          }
        },
        /** 批量重装：`dryRun` 先预检（对应界面上的「确认」步骤），确认后再真装。 */
        async reinstall(body) {
          const requested = Array.isArray(body?.packages) ? body.packages.filter(item => typeof item === 'string' && item !== '') : []
          if (requested.length === 0) throw new Error('没有指定要重装的插件')
          const merged = view()
          const byName = new Map(merged.rows.map(row => [row.packageName, row]))
          const rows = requested.map(item => byName.get(item)).filter(row => row !== undefined)
          const unknown = requested.filter(item => !byName.has(item))
          if (body?.dryRun === true) {
            return { dryRun: true, unknown, planned: await reinstaller.plan(rows) }
          }
          const summary = await reinstaller.run(rows, { skipPresent: body?.skipPresent !== false })
          // 装完立刻核对一次，让刚装上的插件马上进历史；再安排一次推送。
          void collector?.reconcile('reinstall').then(() => engine?.schedule('reinstall'))
          return { dryRun: false, unknown, ...summary }
        },
        /**
         * 存取百度网盘授权。
         * POST 写入，DELETE 清除。**响应里绝不回传 token。**
         */
        async credential(body, request) {
          if (request.method === 'DELETE') {
            await grants.clear()
            const after = await grants.describe()
            return { credential: after }
          }
          const token = typeof body?.accessToken === 'string' ? body.accessToken.trim() : ''
          // 手工兜底：`oob` 形态下用户会直接把百度成功页的整条地址粘进来（token 在 URL
          // 片段里），这里自动提取；纯 token 也照收。这样界面不必区分两种输入。
          const parsed = extractToken(token)
          const finalToken = parsed.ok === true ? parsed.token : token
          if (finalToken === '') throw new Error('没有提供 access token')
          const expiresAt = Number.isFinite(body?.expiresAt)
            ? Number(body.expiresAt)
            : (parsed.ok === true && parsed.expiresIn !== null ? Date.now() + parsed.expiresIn * 1000 : null)
          const written = await grants.write({
            accessToken: finalToken,
            refreshToken: typeof body?.refreshToken === 'string' ? body.refreshToken : null,
            expiresAt,
          })
          if (written.written !== true) {
            throw new Error('宿主的凭据服务不可用，token 没有保存（未落盘，也不会写进历史文件）')
          }
          logEvent('info', 'credential-saved', `source=${written.source}`)
          return { credential: await grants.describe(), saved: true }
        },
        /**
         * 一键连接：开一次授权会话，返回可直接打开的百度授权页地址。
         *
         * 用百度官方 MCP 文档给个人用户的**公开演示应用**（个人用户无法注册应用，
         * 只有企业开发者可以），所以用户不需要 AppKey / SecretKey。演示应用在开放
         * 平台只登记了 `redirect_uri=oob`，授权成功后百度停在 login_success 页，
         * token 在 URL 片段里；本机服务端拿不到片段。DSH Desktop 由 Client 在插件自有的
         * guest webview 中读取成功页地址，非 Desktop 或桥不可用时才读取用户复制到剪贴板的
         * 成功页地址；两种原文都交给 `/oauth/callback` 校验 state、提取 token。
         *
         * 需要「授权后自动回调、拿 refresh_token」的用户得走下面的授权码流程，
         * 也就是使用自己在百度开放平台登记过回调地址的应用。
         */
        async 'oauth-session'() {
          // 演示应用只认 oob：这里不接受调用方传来的 redirectUri，也不再从 Host/Origin
          // 推导本机回调。2026-10-15 线上就是推导出 `http://127.0.0.1:19388/.../oauth/redirect`
          // 交给演示应用，百度才报的 `redirect_uri_mismatch`。
          const redirectUri = DEMO_REDIRECT_URI
          const session = authSessions.start({ redirectUri })
          logEvent('info', 'oauth-session', `mode=${session.mode} redirect=${redirectUri}`)
          return {
            ...session,
            note: redirectUri === 'oob'
              ? '授权页打开后登录（可扫码）并点「授权」；百度会停在 login_success 成功页。请按 Ctrl+L 再按 Ctrl+C 复制整条地址，切回这里后会自动读取，无需粘贴或点按钮。'
              : '在打开的百度页面登录（可扫码）并点「授权」；完成后本机回调页会自动接收，无需复制粘贴。',
          }
        },
        /**
         * 拼「授权码流程」的授权页地址（高级路径：用户拥有自己的应用时用）。
         *
         * 与一键路径的区别：这条需要用户自己的应用（百度目前只给企业开发者注册），
         * 且回调后由宿主拿 code 去换 token（要 SecretKey）。SecretKey 只进凭据存储，
         * **响应里绝不会出现**。
         */
        async 'oauth-authorize-url'(body) {
          const appKey = clipString(body?.appKey, 200)
          const redirectUri = clipString(body?.redirectUri, 512)
          const authorizeUrl = buildAuthorizeUrl({ appKey, redirectUri, state: newId() })
          return {
            authorizeUrl,
            scope: DEFAULT_SCOPE,
            note: '在浏览器打开这个地址：登录（可扫码）后浏览器会跳到回调地址，把地址栏里的整条 URL 粘回「授权码」框即可。',
          }
        },
        /** 查当前授权会话状态（设置页轮询用）。只回状态，不回 token。 */
        async 'oauth-session-status'() {
          const session = authSessions.peek()
          const grant = (await grants.read())?.grant ?? null
          return {
            pending: session !== null,
            expiresAt: session?.expiresAt ?? null,
            redirectUri: session?.redirectUri ?? null,
            connected: grant !== null,
            credential: { configured: grant !== null },
            account: { netdiskName: grant?.baiduName ?? null },
            // 隐式流程只给短期 token、没有 refresh token，这点必须让用户看见。
            refreshable: typeof grant?.refreshToken === 'string' && grant.refreshToken !== '',
          }
        },
        /**
         * 本机授权回调页。
         *
         * token 在 URL 片段（`#access_token=…`）里，服务端根本收不到，所以这里返回一个
         * 页面：页面 JS 先 `replaceState` 把片段从地址栏（以及浏览器历史）里抹掉，再把
         * token POST 给同一路径下的 `/oauth/callback`。页面刻意不引用任何外部资源。
         */
        async 'oauth-redirect'() {
          return {
            __html: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>百度网盘授权</title>
<style>
 body{font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:flex;
      min-height:100vh;align-items:center;justify-content:center;background:#1b1b1f;color:#e8e8ea}
 main{max-width:34rem;padding:2rem;border:1px solid #35353c;border-radius:12px;background:#232329}
 p{margin:.4rem 0 0;color:#b8b8c0}
</style></head>
<body><main><strong>百度网盘授权</strong><p id="msg">正在把授权交给 DSH…</p></main>
<script>
(function () {
  var msg = document.getElementById('msg')
  var raw = location.hash.charAt(0) === '#' ? location.hash.slice(1) : ''
  var params = new URLSearchParams(raw)
  var token = params.get('access_token') || ''
  var state = params.get('state') || ''
  var problem = params.get('error_description') || params.get('error') || ''
  // 先把片段清掉：token 不进浏览器历史，也不留在地址栏里。
  history.replaceState(null, '', location.pathname + location.search)
  if (problem) { msg.textContent = '授权未完成：' + problem; return }
  if (!token) { msg.textContent = '没有收到 access_token。可以把整条地址复制回设置页的高级选项里。'; return }
  fetch('./callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: token, state: state })
  }).then(function (res) {
    return res.json().catch(function () { return {} }).then(function (data) { return { res: res, data: data } })
  }).then(function (out) {
    if (out.res.ok && out.data.ok) { msg.textContent = '授权已接收，可以关闭此页——回到 DSH 设置页即可看到已连接。'; return }
    msg.textContent = '保存失败：' + (out.data.error || ('HTTP ' + out.res.status))
  }).catch(function (error) {
    msg.textContent = '保存失败：' + (error && error.message ? error.message : error)
  })
})()
</script></body></html>`,
          }
        },
        /**
         * 提交授权结果。两条路径共用一个入口：
         *  - 隐式（默认，演示应用）：页面片段里直接是 access_token，带 state 回来；
         *  - 授权码（用户拥有自己的应用时）：带 code + AppKey/SecretKey，由宿主换 token。
         * 响应里永远不会出现 token 或 SecretKey。
         */
        async 'oauth-callback'(body) {
          const submittedToken = typeof body?.token === 'string' ? body.token.trim() : ''
          let appKey = clipString(body?.appKey, 200)
          let secretKey = clipString(body?.secretKey, 200)
          let redirectUri = clipString(body?.redirectUri, 512)
          let grant = null
          if (submittedToken !== '') {
            // 隐式路径必须带对上 state 的会话：没开会话、过期、state 不对，一律拒绝。
            const accepted = authSessions.accept(body?.state)
            if (accepted.ok !== true) {
              logEvent('warn', 'oauth-refused', accepted.reason)
              throw new Error(accepted.reason === 'no-session'
                ? '授权会话不存在或已过期，请重新点击「连接百度网盘」'
                : '授权校验失败（state 不匹配），已拒绝这次提交')
            }
            const parsed = extractToken(submittedToken)
            authSessions.clear() // 一次性：无论后面成不成，都不允许重放
            if (parsed.ok !== true) throw new Error(`提交内容里没有可用的 access token（${parsed.reason}）`)
            appKey = accepted.session.appKey
            redirectUri = accepted.session.redirectUri
            grant = implicitGrant(parsed)
          } else {
            grant = await exchangeCode({
              appKey,
              secretKey,
              code: typeof body?.code === 'string' ? body.code : '',
              redirectUri,
            })
          }
          // 顺手问一次账号信息：界面能立刻显示连的是哪个账号，本地缓存也能一开始
          // 就落在正确的账号命名空间下（否则第一次同步才会知道 uk）。
          let account = null
          try {
            account = await createBaiduTransport({
              token: grant.accessToken,
              remoteDir: settings.remoteDir,
              schemaVersion: SCHEMA_VERSION,
              onWarn,
            }).getAccount()
          } catch (error) {
            logEvent('warn', 'oauth-account', error instanceof Error ? error.message : String(error))
          }
          const written = await grants.write({
            ...grant,
            appKey,
            secretKey,
            redirectUri,
            uk: account?.uk ?? null,
            baiduName: account?.netdiskName ?? null,
          })
          if (written.written !== true) {
            throw new Error('宿主的凭据服务不可用，授权没有保存（未落盘，也不会写进历史文件）')
          }
          logEvent('info', 'oauth-authorized', `scope=${grant.scope ?? DEFAULT_SCOPE} account=${account?.netdiskName ?? '(未知)'}`)
          return {
            credential: await grants.describe(),
            account: account === null ? null : { netdiskName: account.netdiskName },
            expiresAt: grant.expiresAt,
          }
        },
        /**
         * 测试云端目录能不能读写（方案里的「测试读写」）。
         * 未授权时如实报未授权，不假装成功。
         */
        async 'storage-test'() {
          const grant = (await grants.read())?.grant ?? null
          if (grant === null) return { ok: false, reason: 'unconfigured', error: '还没有授权百度网盘' }
          const transport = createBaiduTransport({
            token: grant.accessToken,
            remoteDir: settings.remoteDir,
            schemaVersion: SCHEMA_VERSION,
            onWarn,
          })
          const result = await transport.probe()
          let account = null
          try {
            account = await transport.getAccount()
          } catch (error) {
            onWarn(`测试读写时读取账号失败：${error?.message ?? error}`)
          }
          logEvent(result.ok ? 'info' : 'warn', 'storage-test',
            `dir=${result.dir} readBack=${result.readBack} removed=${result.removed}${result.error === null ? '' : ` error=${result.error}`}`)
          return {
            ...result,
            account: account === null ? null : { netdiskName: account.netdiskName },
            remoteDir: settings.remoteDir,
          }
        },
        /** 改本机设备名，跨设备历史里显示的就是它。 */
        async device(body) {
          const label = typeof body?.label === 'string' ? body.label.trim() : ''
          const device = setDeviceLabel(label === '' ? null : label)
          logEvent('info', 'device-label', `label=${device.deviceLabel ?? '(未命名)'}`)
          return { device }
        },
      },
    })
    hostCtx.effect(() => api.register(hostCtx.webServer), 'dsh-history-plugin: http api')
    // 明确记一条带路由数量的日志：重启后只靠命令行看不到 API（宿主闸要求登录会话），
    // 这条日志就是「新代码确实加载了、接口确实挂上了」的现场证据。
    // 末尾的 build 标记用于确认「动态重载有没有真的读到磁盘上的新代码」：
    // ESM 模块有缓存，只看路径数分辨不出新旧版本。
    logEvent('info', 'http-api-ready', `${api.registeredPaths.length} paths / ${api.routes.length} methods at ${API_PREFIX} · build=oauth-oob-8 `)
  })
}

/**
 * 给后续阶段与测试复用的本机只读视图。
 *
 * 放在这里而不是 collector 里，是因为「读一份合并后的历史」既服务 UI，
 * 也服务同步上传，两边必须是同一份聚合逻辑。
 * @param {object[]} [entries] 事件列表；缺省读本机账本。
 * @returns {{ device: object, rows: object[], eventCount: number }} 视图数据。
 */
export function historyView(entries) {
  const list = Array.isArray(entries) ? entries : loadHistory().entries
  return {
    device: loadDevice(),
    rows: aggregateByPackage(list),
    eventCount: list.length,
  }
}
