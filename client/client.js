/**
 * dsh-history-plugin · 客户端半边
 *
 * 形态照抄同版本 DSH 里能跑的官方做法（dsh-brand 的 client bundle）：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 里 `require('react')`
 * 解析到 shell 的共享 external，最后返回一个 **Cordis 插件对象**
 * `{ name, inject: ['slots'], apply }`——客户端半边本身就是个插件。
 *
 * ## 座位是怎么选的（这三个槽位都不是随便挑的）
 *
 *  - **附图1「历史安装」页签 → `settings.plugins.tab`。** 宿主槽位契约里它的用途
 *    原文是 "One page inside the Plugins settings section"，即「与宿主自己的页签
 *    并排的一个 Plugins 设置页面」，注册面是 `{ id, order, label }`。
 *  - **附图2「历史插件」设置项 → `settings.section`。** 用途「每个条目一个设置页」。
 *  - **自己 bundle 页上的卡片 → `plugins.bundle.config`。** 契约明说第三方 bundle
 *    的配置属于这里（按包名 keyed）。
 *  - **刻意不用 `plugins.item`。** 它的用途写的是「Plugins 页 Official 分组里列出的
 *    一个**官方**插件卡片」，dshmarket 也记着同一句：该座位「OCCUPIED by the official
 *    settings pages」。占了它只会把官方列表搞乱。
 *
 * 所有注册都走 `slots.inject(slot, () => slots.register(...))`：`inject` 会等槽位
 * 出现，所以老版本宿主上宁可什么都不注册，也不会出现「注册成功但界面里静默消失」。
 */

window.__ModuleLoader__.load({
  id: 'dsh-history-plugin',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-history-plugin/api/v1'
    /** 样式类名前缀，避免影响宿主。 */
    const NS = 'dsh-hist'
    /**
     * 桌面版插件专用浏览器分区的存储身份。
     *
     * 宿主按这个字符串分配一个归插件所有的分区（同一进程生命周期内复用），
     * 所以百度登录态只留在我们自己这个 guest 里，和侧边栏浏览器标签页互不影响。
     */
    const AUTH_WORKSPACE = 'dsh-history-plugin:baidu-auth'
    /**
     * 授权页从开始加载到给出可用导航的上限（毫秒）。
     *
     * 超时按失败处理，交给调用方回退到剪贴板路径——按钮停在「授权中…」比报错更糟，
     * 用户既不知道发生了什么，也没法重试。
     */
    const AUTH_LOAD_TIMEOUT_MS = 30_000

    /** 用主题变量写样式：明暗主题自动跟随，不硬编码颜色。 */
    const CSS = `
.${NS}-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary); }
.${NS}-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.${NS}-title { font-size: 15px; font-weight: 600; margin: 0; }
.${NS}-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${NS}-grow { flex: 1 1 auto; }
.${NS}-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.${NS}-card h4 { margin: 0; font-size: 13px; font-weight: 600; }
.${NS}-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; line-height: 1.6; }
.${NS}-btn:hover:enabled { border-color: var(--dsw-alias-brand-primary); }
.${NS}-btn:disabled { opacity: .5; cursor: default; }
.${NS}-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.${NS}-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 10px; font-size: 12px; min-width: 220px; }
.${NS}-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${NS}-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.${NS}-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.${NS}-table td { padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.${NS}-table tr:last-child td { border-bottom: 0; }
.${NS}-name { font-weight: 600; }
.${NS}-spec { color: var(--dsw-alias-label-secondary); font-size: 11px; word-break: break-all; }
.${NS}-tag { display: inline-block; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 7px; font-size: 11px; line-height: 17px; margin: 0 3px 3px 0; white-space: nowrap; }
.${NS}-tag-here { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.${NS}-tag-missing { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.${NS}-tag-none { color: var(--dsw-alias-label-secondary); }
.${NS}-ok { color: var(--dsw-alias-state-success-primary); }
.${NS}-warn { color: var(--dsw-alias-state-warn-primary); }
.${NS}-err { color: var(--dsw-alias-state-error-primary); }
.${NS}-empty { padding: 26px 8px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${NS}-plan { border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.${NS}-scroll { overflow: auto; max-height: 60vh; }
.${NS}-auth-overlay { position: fixed; inset: 0; z-index: 2147483000; pointer-events: auto; display: flex; align-items: center; justify-content: center; padding: 4vh 4vw; background: var(--dsw-alias-bg-mask-3); }
.${NS}-auth-panel { display: flex; flex-direction: column; width: min(880px, 94vw); height: min(720px, 88vh); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 12px 40px var(--dsw-alias-bg-mask-3); }
.${NS}-auth-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.${NS}-auth-title { font-size: 13px; font-weight: 600; }
.${NS}-auth-frame { flex: 1 1 auto; min-height: 0; background: var(--dsw-alias-bg-base); }
.${NS}-auth-frame webview { width: 100%; height: 100%; border: 0; }
`

    /**
     * 调宿主接口。
     * @param {string} path 相对路径。
     * @param {{ method?: string, body?: unknown }} [options] 选项。
     * @returns {Promise<any>} 响应体。
     */
    async function api(path, options = {}) {
      const response = await fetch(API + path, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = { error: text }
      }
      if (response.ok !== true || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * 把时间戳显示成本地时间。
     * @param {string|null} value ISO 时间戳。
     * @returns {string} 显示文本。
     */
    function fmt(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    /**
     * 只做「像不像百度成功页地址」的**形状**判断。
     *
     * 用途是别把剪贴板里无关的内容送去提交。命中后 Client 只把原文当作不透明结果转交
     * Host；token 的提取始终由 Host（`extractToken`）完成。Client 不解析、不回显、
     * 不持久化 token。
     * @param {unknown} text 剪贴板文本。
     * @returns {boolean} 是否像百度 OAuth 成功页地址。
     */
    function looksLikeBaiduResult(text) {
      return typeof text === 'string'
        && text.length > 0
        && text.length < 4096
        && text.includes('openapi.baidu.com/oauth/2.0/login_success')
        && text.includes('access_token=')
    }

    /**
     * 读剪贴板。任何一种「暂时读不到」都返回失败原因，由调用方决定下一步：
     *  - 窗口没有焦点（用户还在浏览器里）→ 浏览器会直接拒绝读取；
     *  - 宿主没有放行剪贴板权限；
     *  - 剪贴板里不是文本。
     * 这里刻意不抛异常、不打印内容；只回报是否可用与失败类型。
     * @returns {Promise<{ ok: boolean, text: string, reason: string|null }>} 读取结果。
     */
    async function readClipboardText() {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
          return { ok: false, text: '', reason: 'unavailable' }
        }
        if (typeof navigator.clipboard.readText !== 'function') {
          return { ok: false, text: '', reason: 'unsupported' }
        }
        const text = await navigator.clipboard.readText()
        return { ok: true, text: typeof text === 'string' ? text : '', reason: null }
      } catch (error) {
        return {
          ok: false,
          text: '',
          reason: error !== null && typeof error === 'object' && error.name === 'NotAllowedError'
            ? 'denied'
            : 'failed',
        }
      }
    }

    /**
     * 取 DSH 桌面版开放给插件的浏览器桥。
     *
     * 宿主只在预加载脚本里、且只对主框架暴露 `dshDesktop`；协议版本是唯一的兼容
     * 判据——版本对不上就当这个能力不存在，走剪贴板回退，而不是拿半个桥去试。
     * @returns {any} 浏览器桥；非桌面宿主或协议不符时是 undefined。
     */
    function desktopBrowserBridge() {
      const carrier = typeof globalThis === 'undefined' ? undefined : globalThis.dshDesktop
      if (carrier === null || typeof carrier !== 'object' || carrier.protocolVersion !== 1) return undefined
      const browser = carrier.browser
      if (browser === null || typeof browser !== 'object') return undefined
      if (typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return undefined
      return browser
    }

    /**
     * 在插件自己持有的 guest webview 里跑完一次百度授权，把成功页地址读回来。
     *
     * 为什么需要它：演示应用只登记 `redirect_uri=oob`，授权成功页把 token 放在 URL
     * 片段里，服务端收不到、跨域 iframe 也读不到。DSH 桌面版按协议版本 1 给插件留了
     * 一个**归插件所有**的 guest：分区由宿主发放，创建、导航、销毁都在插件这一侧，
     * 于是可以直接 `getURL()` 把地址拿回来。这里只读这一条地址——不碰用户的其它
     * 标签页、Cookie 或剪贴板；token 的解析仍然只由 Host 完成。
     *
     * 拿不到桥、宿主没放行分区、或页面起不来时都如实报错，由调用方回退到剪贴板路径。
     * @param {{
     *   bridge: any,
     *   authorizeUrl: string,
     *   matches: (url: string) => boolean,
     *   onResult: (url: string) => void,
     *   onError: (message: string) => void,
     *   onCancel: () => void,
     * }} options 参数。
     * @returns {{ cancel: () => void }} 句柄：取消会撤掉页面并释放宿主分区。
     */
    function runDesktopAuthorization(options) {
      const bridge = options.bridge
      let stopped = false
      let lease = null
      let view = null
      let loadTimer = null

      const overlay = document.createElement('div')
      overlay.className = `${NS}-auth-overlay`
      // 自己就是一层模态：宿主据此把它当对话框，而不是设置弹窗的背景内容。
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-label', '百度授权')
      const panel = document.createElement('div')
      panel.className = `${NS}-auth-panel`
      const bar = document.createElement('div')
      bar.className = `${NS}-auth-bar`
      const title = document.createElement('span')
      title.className = `${NS}-auth-title`
      title.textContent = '百度授权'
      const hint = document.createElement('span')
      hint.className = `${NS}-muted`
      hint.textContent = '登录并点「授权」，成功后会自动回到设置页，无需复制地址'
      const cancelButton = document.createElement('button')
      cancelButton.className = `${NS}-btn`
      cancelButton.textContent = '取消'
      const frame = document.createElement('div')
      frame.className = `${NS}-auth-frame`
      bar.appendChild(title)
      bar.appendChild(hint)
      bar.appendChild(cancelButton)
      panel.appendChild(bar)
      panel.appendChild(frame)
      overlay.appendChild(panel)
      /**
       * 挂载点：优先挂进设置弹窗自己的遮罩容器，跟它同层；宿主的设置弹窗是
       * `document.body` 上的 portal，自带 `z-index:1000` 的遮罩，直接挂 body 会被
       * 它压住——这正是「点了连接、按钮变授权中，却看不到登录页」的成因。
       * 只有拿不到设置容器（例如从别处调用）才退回 body：主题变量本来就定义在
       * body 上，两种挂法都不用自己猜颜色。
       */
      const settingsDialog = typeof document.querySelector === 'function'
        ? document.querySelector('[data-shortcut-modal="settings"]')
        : null
      const settingsOverlay = settingsDialog === null || settingsDialog === undefined
        ? null
        : settingsDialog.parentElement
      const mountHost = settingsOverlay !== null && settingsOverlay !== undefined
        && typeof settingsOverlay.appendChild === 'function'
        ? settingsOverlay
        : document.body
      mountHost.appendChild(overlay)

      /** 清掉加载计时器；重复调用无害。 */
      const clearLoadTimer = () => {
        if (loadTimer !== null) {
          clearTimeout(loadTimer)
          loadTimer = null
        }
      }

      /** 撤掉 guest、卸载覆盖层、把分区还给宿主。重复调用是无害的。 */
      const teardown = () => {
        clearLoadTimer()
        document.removeEventListener('keydown', onKeyDown, true)
        if (view !== null) {
          const element = view
          view = null
          try {
            element.remove()
          } catch {
            /* 已经不在 DOM 里 */
          }
        }
        try {
          overlay.remove()
        } catch {
          /* 同上 */
        }
        if (lease !== null) {
          const id = lease
          lease = null
          try {
            const pending = bridge.release(id)
            if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
              pending.catch(() => {})
            }
          } catch {
            /* 宿主已经回收过了 */
          }
        }
      }
      const cancel = () => {
        if (stopped) return
        stopped = true
        teardown()
        options.onCancel()
      }
      cancelButton.addEventListener('click', cancel)

      const fail = message => {
        if (stopped) return
        stopped = true
        teardown()
        options.onError(message)
      }

      /**
       * 键盘守卫：覆盖层是文档里最上层的模态，Escape 归它（取消授权），Tab 也留在
       * 这一层，别让后面的设置弹窗抢走焦点、或把设置页一起关掉。
       *
       * 设置弹窗的 `useModalLayer` 同样监听 document keydown，但它会先看
       * `event.defaultPrevented`——这里在捕获阶段 preventDefault 即让它让位。
       * 焦点在 guest 里（用户正在输账号）时事件不进宿主文档，所以不影响登录本身。
       */
      const onKeyDown = event => {
        if (stopped) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancel()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          try {
            cancelButton.focus()
          } catch {
            /* 没有焦点实现的环境（测试替身）忽略 */
          }
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      try {
        cancelButton.focus()
      } catch {
        /* 同上 */
      }

      /** 起一段「授权页必须尽快给出可用导航」的计时；超时按失败回退。 */
      const armLoadTimer = () => {
        clearLoadTimer()
        loadTimer = setTimeout(() => {
          loadTimer = null
          fail('授权页加载超时，')
        }, AUTH_LOAD_TIMEOUT_MS)
      }

      void (async () => {
        let reservation = null
        try {
          reservation = await bridge.acquire(AUTH_WORKSPACE)
        } catch {
          fail('插件窗口没能拿到独立的浏览器分区，')
          return
        }
        const ok = reservation !== null
          && typeof reservation === 'object'
          && typeof reservation.lease === 'string'
          && typeof reservation.partition === 'string'
        if (stopped) {
          if (ok) {
            try {
              const pending = bridge.release(reservation.lease)
              if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(() => {})
            } catch {
              /* 忽略 */
            }
          }
          return
        }
        if (ok !== true) {
          fail('插件窗口返回的浏览器分区不完整，')
          return
        }
        lease = reservation.lease
        const element = document.createElement('webview')
        // 宿主按这三条核对归属：`src` 必须是 about:blank#<lease>，分区必须是它发的那一个。
        element.setAttribute('name', reservation.lease)
        element.setAttribute('partition', reservation.partition)
        element.setAttribute('allowpopups', '')
        element.setAttribute('src', `about:blank#${reservation.lease}`)
        view = element
        let bootstrapped = false
        const inspect = () => {
          if (stopped) return
          // 页面已经在给出导航，计时使命结束。
          clearLoadTimer()
          let current = ''
          try {
            current = element.getURL()
          } catch {
            return
          }
          if (typeof current !== 'string' || current === '' || current.startsWith('about:blank')) return
          if (options.matches(current) !== true) return
          // 地址已经在手里，授权页没有理由继续留在插件窗口上。
          stopped = true
          teardown()
          options.onResult(current)
        }
        element.addEventListener('dom-ready', () => {
          if (stopped) return
          if (bootstrapped === false) {
            bootstrapped = true
            armLoadTimer()
            try {
              element.loadURL(options.authorizeUrl)
            } catch {
              fail('授权页没能加载，')
            }
            return
          }
          inspect()
        })
        for (const name of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
          element.addEventListener(name, inspect)
        }
        element.addEventListener('did-fail-load', event => {
          if (stopped) return
          if (event !== null && typeof event === 'object' && event.isMainFrame !== true) return
          // -3 是导航被主动中止（重定向很常见），不算真失败。
          if (event !== null && typeof event === 'object' && event.errorCode === -3) return
          fail('授权页加载失败，')
        })
        frame.appendChild(element)
      })()

      return { cancel }
    }

    /**
     * 主面板。附图1 的页签与附图2 的设置项渲染的是同一个组件——两处必须是同一份
     * 逻辑，否则「按设备归类」这件事会在两个入口给出不同答案。
     * @returns {unknown} 元素。
     */
    function HistoryPage() {
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      /** all | missing | reinstallable */
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState({})
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [labelDraft, setLabelDraft] = React.useState('')
      // OAuth：应用凭据只在这里暂存，提交后直接进宿主安全存储，界面不回读。
      const [appKey, setAppKey] = React.useState('')
      const [secretKey, setSecretKey] = React.useState('')
      const [redirectUri, setRedirectUri] = React.useState('')
      const [codeDraft, setCodeDraft] = React.useState('')
      // 一键授权：只记授权页已打开、对应 state 与会话过期时间；token 的提取始终在 Host。
      const [connectDraft, setConnectDraft] = React.useState(null)
      // 桌面版在插件窗口内跑授权页时的打开状态（按钮据此禁用并改文案）。
      const [authOpen, setAuthOpen] = React.useState(false)
      /** 正在跑的桌面授权句柄；离开设置页时要把它连页面一起撤掉。 */
      const authRef = React.useRef(null)

      React.useEffect(() => () => {
        if (authRef.current !== null) {
          const handle = authRef.current
          authRef.current = null
          handle.cancel()
        }
      }, [])

      /** 同时刷新历史与状态。 */
      const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
          const [history, state] = await Promise.all([api('/history'), api('/status')])
          setData(history)
          setStatus(state)
          setLabelDraft(state?.device?.deviceLabel ?? '')
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const rows = data?.rows ?? []
      const deviceLabels = new Map((data?.devices ?? []).map(device => [device.deviceId, device.label]))
      const here = data?.deviceId ?? null

      /** 按搜索词与筛选条件过滤。 */
      const visible = rows.filter(row => {
        if (filter === 'missing' && row.present === true) return false
        if (filter === 'reinstallable' && row.reinstallable !== true) return false
        if (query !== '') {
          const haystack = `${row.packageName} ${row.key} ${(row.versions ?? []).join(' ')}`.toLowerCase()
          if (!haystack.includes(query.trim().toLowerCase())) return false
        }
        return true
      })

      const selectedNames = Object.keys(selected).filter(name => selected[name] === true)
      const missingCount = rows.filter(row => row.present !== true).length

      /** 执行一个会改状态的动作，统一处理忙碌与错误。 */
      const run = React.useCallback(async (label, task) => {
        setBusy(label)
        setNote(null)
        try {
          const result = await task()
          return result
        } catch (failure) {
          setNote({ kind: 'err', text: failure instanceof Error ? failure.message : String(failure) })
          return null
        } finally {
          setBusy(null)
        }
      }, [])

      /** 手动同步。 */
      const onSync = () => run('sync', async () => {
        const result = await api('/sync', { method: 'POST', body: {} })
        const pulled = result.pulled ?? {}
        const pushed = result.pushed ?? {}
        if (pulled.ok !== true && pushed.ok !== true) {
          setNote({ kind: 'warn', text: `同步未完成：${pulled.reason ?? pushed.reason ?? '未知'}${pulled.error ? ` — ${pulled.error}` : ''}` })
        } else {
          setNote({
            kind: 'ok',
            text: `已拉取 ${pulled.deviceCount ?? 0} 台设备、推送 ${pushed.entries ?? 0} 条${(pulled.skipped ?? []).length > 0 ? `；跳过 ${(pulled.skipped ?? []).length} 份异常文件` : ''}`,
          })
        }
        await refresh()
        return result
      })

      /** 清除授权。 */
      const onClearToken = () => run('token', async () => {
        await api('/credential', { method: 'DELETE' })
        setNote({ kind: 'ok', text: '已清除网盘授权。' })
        await refresh()
      })

      /**
       * 打开百度授权页（那一页可以扫码登录）。
       *
       * 一键连接走的是百度公开演示应用：它的回调只能是 oob，授权成功后百度停在
       * login_success 页，token 在地址栏片段里，片段不会自动回到本机。Desktop 宿主
       * （桥协议版本 1）时，授权页跑在**插件自己持有**的 guest webview 里，插件直接
       * 读回成功页地址；其它宿主没有这个能力，退回原来那条「复制一次地址、自动读
       * 剪贴板」的路径。两条路都把原文交给 Host，解析与保存始终在 Host。
       */
      const onConnect = () => run('connect', async () => {
        const session = await api('/oauth/session', { method: 'POST', body: {} })
        const authorizeUrl = typeof session?.authorizeUrl === 'string' ? session.authorizeUrl : ''
        const state = typeof session?.state === 'string' ? session.state : ''
        const expiresAt = session?.expiresAt ?? null
        const bridge = desktopBrowserBridge()

        // 交付一条「保存成功」的收尾；两条路径共用。
        const finish = async url => {
          try {
            const result = await api('/oauth/callback', {
              method: 'POST',
              body: { token: url, state },
            })
            setConnectDraft(null)
            setNote({
              kind: 'ok',
              text: `已自动完成百度网盘授权${result?.account?.netdiskName ? `：${result.account.netdiskName}` : ''}。`,
            })
            await refresh()
          } catch (failure) {
            setNote({
              kind: 'warn',
              text: `已读到百度成功页，但保存失败：${failure instanceof Error ? failure.message : String(failure)}。请重新点「连接百度网盘」。`,
            })
          }
        }

        if (bridge === undefined || authorizeUrl === '') {
          // 非桌面宿主：保持原来的新标签页 + 剪贴板回传。
          if (authorizeUrl !== '') window.open(authorizeUrl, '_blank', 'noopener')
          setConnectDraft({ state, expiresAt })
          setNote({
            kind: 'ok',
            text: typeof session?.note === 'string' && session.note !== ''
              ? session.note
              : '已打开百度授权页。登录并点「授权」后，在百度成功页按 Ctrl+L、Ctrl+C；切回这里会自动读取，无需粘贴或点按钮。',
          })
          return session
        }

        // 桌面宿主：授权页就在插件窗口里，读完地址立刻撤页并释放分区。
        setAuthOpen(true)
        authRef.current = runDesktopAuthorization({
          bridge,
          authorizeUrl,
          matches: looksLikeBaiduResult,
          onCancel: () => {
            authRef.current = null
            setAuthOpen(false)
            setNote({ kind: 'warn', text: '已取消百度授权，没有保存任何凭据。' })
          },
          onError: message => {
            authRef.current = null
            setAuthOpen(false)
            // 桌面通道不可用时退回剪贴板：会话还在有效期内，复制一次地址即可。
            setConnectDraft({ state, expiresAt })
            setNote({
              kind: 'warn',
              text: `${message}请在百度成功页按 Ctrl+L、Ctrl+C 复制地址，切回来会自动读取。`,
            })
          },
          onResult: url => {
            authRef.current = null
            setAuthOpen(false)
            void finish(url)
          },
        })
        setNote({
          kind: 'ok',
          text: '已在插件窗口内打开百度授权页：登录（可扫码或输账号）并点「授权」，成功后会自动完成连接，无需复制地址。',
        })
        return session
      })
      /** 重新读一次剪贴板；用于用户首次未复制成功或剪贴板权限稍后恢复。 */
      const onRetryClipboard = () => {
        setConnectDraft(current => current === null
          ? null
          : { ...current, retry: (current.retry ?? 0) + 1 })
        setNote({ kind: 'ok', text: '请确认浏览器当前停在百度 login_success 成功页，并按 Ctrl+L、Ctrl+C；随后会自动读取，无需粘贴。' })
      }
      const onAuthorize = () => run('authorize', async () => {
        const result = await api('/oauth/authorize-url', {
          method: 'POST',
          body: { appKey, redirectUri },
        })
        setNote({
          kind: 'ok',
          text: '已打开授权页。登录（可扫码）并同意后，浏览器会跳到回调地址；把地址栏里的整条 URL 粘到下面「授权码」框里即可。',
        })
        // 回调地址通常打不开（没有本地服务），所以提示用户复制地址栏，而不是等它跳回来。
        window.open(result.authorizeUrl, '_blank', 'noopener')
        return result
      })

      /** 用授权码换取 token 并保存。 */
      const onExchange = () => run('exchange', async () => {
        const result = await api('/oauth/callback', {
          method: 'POST',
          body: { appKey, secretKey, redirectUri, code: codeDraft },
        })
        setCodeDraft('')
        setSecretKey('')
        setNote({
          kind: 'ok',
          text: `授权成功${result?.account?.netdiskName ? `：${result.account.netdiskName}` : ''}。之后 token 会在过期前自动刷新，不用再手动粘。`,
        })
        await refresh()
        return result
      })

      /** 改设备名。 */
      const onSaveLabel = () => run('label', async () => {
        await api('/device', { method: 'POST', body: { label: labelDraft } })
        setNote({ kind: 'ok', text: '设备名已保存，跨设备历史里显示的就是它。' })
        await refresh()
      })

      /** 批量重装第一步：预检，让用户看清楚会发生什么。 */
      const onPlan = () => run('plan', async () => {
        if (selectedNames.length === 0) {
          setNote({ kind: 'warn', text: '先勾选要装回的插件。' })
          return null
        }
        const result = await api('/reinstall', { method: 'POST', body: { packages: selectedNames, dryRun: true } })
        setPlan(result)
        setNote(null)
        return result
      })

      /** 批量重装第二步：确认后真装。 */
      const onConfirm = () => run('install', async () => {
        const result = await api('/reinstall', { method: 'POST', body: { packages: selectedNames } })
        setPlan(null)
        setSelected({})
        const parts = [`装好 ${result.installed ?? 0} 个`]
        if ((result.skipped ?? 0) > 0) parts.push(`跳过已装 ${result.skipped}`)
        if ((result.failed ?? 0) > 0) parts.push(`失败 ${result.failed}`)
        if ((result.needsRestart ?? 0) > 0) parts.push(`其中 ${result.needsRestart} 个需要重启 DSH 才生效`)
        setNote({ kind: (result.failed ?? 0) > 0 ? 'warn' : 'ok', text: parts.join('，') })
        await refresh()
        return result
      })

      /** 勾选所有「本机缺失且可重装」的行。 */
      const selectAllMissing = () => {
        const next = {}
        for (const row of rows) {
          if (row.present !== true && row.reinstallable === true) next[row.packageName] = true
        }
        setSelected(next)
      }

      const credential = status?.credential ?? null
      const sync = status?.sync ?? null

      // oob 授权成功后，百度把 access token 放在地址栏片段里；本机收不到重定向。
      // 在连接会话有效期内，只在 DSH 窗口重新获得焦点后读剪贴板：只检查它像不像
      // 百度成功页地址，命中后把原文交给 Host 做 state 校验与 token 提取。
      // Client 不解析、不回显、不保存 token，也不在后台持续读取窗口外的剪贴板。
      React.useEffect(() => {
        if (connectDraft === null || credential?.configured === true) return undefined
        let stopped = false
        let inFlight = false
        let lastAttempt = ''
        let clipboardWarned = false
        const tick = async () => {
          if (stopped || inFlight) return
          if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus() !== true) return
          const expiresAt = Date.parse(connectDraft.expiresAt)
          if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
            stopped = true
            setConnectDraft(null)
            setNote({ kind: 'warn', text: '授权会话已过期，请重新点「连接百度网盘」。' })
            return
          }
          const clipboard = await readClipboardText()
          if (stopped) return
          if (clipboard.ok !== true) {
            if (clipboardWarned === false) {
              clipboardWarned = true
              setNote({
                kind: 'warn',
                text: clipboard.reason === 'denied'
                  ? 'DSH 尚未放行剪贴板读取。请点「重新读取剪贴板」；若仍失败，关闭并重新打开设置页后再试。'
                  : '当前环境无法读取剪贴板。请点「重新读取剪贴板」；若仍失败，关闭并重新打开设置页后再试。',
              })
            }
            return
          }
          clipboardWarned = false
          const text = clipboard.text
          if (stopped || !looksLikeBaiduResult(text) || text === lastAttempt) return
          lastAttempt = text
          inFlight = true
          try {
            const result = await api('/oauth/callback', {
              method: 'POST',
              body: { token: text, state: connectDraft.state },
            })
            stopped = true
            setConnectDraft(null)
            setNote({
              kind: 'ok',
              text: `已自动读取百度成功页并完成连接${result?.account?.netdiskName ? `：${result.account.netdiskName}` : ''}。`,
            })
            await refresh()
          } catch (failure) {
            if (!stopped) {
              setNote({
                kind: 'warn',
                text: `读到百度成功页，但保存失败：${failure instanceof Error ? failure.message : String(failure)}。请在成功页重新按 Ctrl+L、Ctrl+C。`,
              })
            }
          } finally {
            inFlight = false
          }
        }
        void tick()
        const timer = setInterval(() => {
          void tick()
        }, 1500)
        const onFocus = () => {
          void tick()
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', onFocus)
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onFocus)
        }
        return () => {
          stopped = true
          clearInterval(timer)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('focus', onFocus)
          }
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onFocus)
          }
        }
      }, [connectDraft, credential?.configured, refresh])

      return h('div', { className: `${NS}-wrap` },
        h('div', { className: `${NS}-head` },
          h('h3', { className: `${NS}-title` }, '历史安装'),
          h('span', { className: `${NS}-muted` },
            `${rows.length} 个插件 · ${data?.entryCount ?? 0} 条记录 · ${data?.devices?.length ?? 0} 台设备`),
          h('span', { className: `${NS}-grow` }),
          h('button', { className: `${NS}-btn`, onClick: refresh, disabled: busy !== null || loading }, loading ? '读取中…' : '刷新'),
          h('button', { className: `${NS}-btn ${NS}-btn-primary`, onClick: onSync, disabled: busy !== null || credential?.configured !== true },
            busy === 'sync' ? '同步中…' : '同步网盘')),

        // 云与设备：这两块合起来就是「按设备归类 + 跨设备」的操作面。
        h('div', { className: `${NS}-card` },
          h('h4', null, '云同步（百度网盘）'),
          h('div', { className: `${NS}-row` },
            h('span', { className: credential?.configured === true ? `${NS}-ok` : `${NS}-warn` },
              credential?.configured === true
                ? `已授权${credential.source === 'env' || credential.source === 'token-file' ? '（来自本机环境变量）' : ''}`
                : '未授权'),
            h('span', { className: `${NS}-muted` }, `目录 ${sync?.remoteDir ?? '—'}`),
            sync?.lastPullAt ? h('span', { className: `${NS}-muted` }, `上次拉取 ${fmt(sync.lastPullAt)}`) : null,
            sync?.lastPushAt ? h('span', { className: `${NS}-muted` }, `上次推送 ${fmt(sync.lastPushAt)}`) : null,
            sync?.pendingPush === true ? h('span', { className: `${NS}-warn` }, '有改动待推送') : null),
          sync?.lastError ? h('div', { className: `${NS}-err` }, `上次同步失败：${sync.lastError}`) : null,
          h('div', { className: `${NS}-row` },
            h('span', { className: `${NS}-grow` }),
            connectDraft === null ? null : h('span', { className: `${NS}-muted` }, '等待剪贴板里的百度成功页地址（无需粘贴）'),
            connectDraft === null
              ? null
              : h('button', { className: `${NS}-btn`, onClick: onRetryClipboard, disabled: busy !== null }, '重新读取剪贴板'),
            connectDraft === null ? null : h('button', { className: `${NS}-btn`, onClick: () => setConnectDraft(null), disabled: busy !== null }, '取消'),
            credential?.configured === true
              ? h('button', { className: `${NS}-btn`, onClick: onClearToken, disabled: busy !== null }, '断开连接')
              : h('button', {
                className: `${NS}-btn ${NS}-btn-primary`,
                onClick: onConnect,
                disabled: busy !== null || authOpen,
              }, authOpen ? '授权中…' : '连接百度网盘')),
          h('details', { className: `${NS}-oauth` },
            h('summary', null, '高级'),
            h('div', { className: `${NS}-muted` }, '正式发布形态：使用自己的百度应用和登记过的本机回调。'),
            h('div', { className: `${NS}-row` },
              h('input', {
                className: `${NS}-input`,
                placeholder: 'AppKey（API Key）',
                value: appKey,
                onChange: event => setAppKey(event.target.value),
              }),
              h('input', {
                className: `${NS}-input`,
                type: 'password',
                placeholder: 'SecretKey（只进宿主安全存储）',
                value: secretKey,
                onChange: event => setSecretKey(event.target.value),
              })),
            h('div', { className: `${NS}-row` },
              h('input', {
                className: `${NS}-input`,
                placeholder: '回调地址（必须与开放平台登记的一致）',
                value: redirectUri,
                onChange: event => setRedirectUri(event.target.value),
              }),
              h('button', {
                className: `${NS}-btn`,
                onClick: onAuthorize,
                disabled: busy !== null || appKey.trim() === '' || redirectUri.trim() === '',
              }, '打开授权页')),
            h('div', { className: `${NS}-row` },
              h('input', {
                className: `${NS}-input`,
                placeholder: '授权后把回调地址整条 URL 粘到这里（或只粘 code）',
                value: codeDraft,
                onChange: event => setCodeDraft(event.target.value),
              }),
              h('button', {
                className: `${NS}-btn`,
                onClick: onExchange,
                disabled: busy !== null || appKey.trim() === '' || secretKey.trim() === '' || codeDraft.trim() === '',
              }, '完成授权'))),
          h('div', { className: `${NS}-row` },
            h('span', { className: `${NS}-muted` }, '本机设备名'),
            h('input', {
              className: `${NS}-input`,
              placeholder: '默认取系统设备名',
              value: labelDraft !== '' ? labelDraft : (status?.device?.deviceLabel ?? status?.device?.label ?? ''),
              onChange: event => setLabelDraft(event.target.value),
            }),
            h('button', { className: `${NS}-btn`, onClick: onSaveLabel, disabled: busy !== null }, '保存'),
            h('span', { className: `${NS}-muted` }, `设备 ID ${(status?.device?.deviceId ?? '').slice(0, 8) || '—'}`))),

        // 筛选与批量操作。
        h('div', { className: `${NS}-row` },
          h('input', {
            className: `${NS}-input`,
            placeholder: '搜索插件名 / 版本',
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('button', { className: `${NS}-btn ${filter === 'all' ? `${NS}-btn-primary` : ''}`, onClick: () => setFilter('all') }, `全部 ${rows.length}`),
          h('button', { className: `${NS}-btn ${filter === 'missing' ? `${NS}-btn-primary` : ''}`, onClick: () => setFilter('missing') }, `本机缺失 ${missingCount}`),
          h('button', { className: `${NS}-btn ${filter === 'reinstallable' ? `${NS}-btn-primary` : ''}`, onClick: () => setFilter('reinstallable') }, '可装回'),
          h('span', { className: `${NS}-grow` }),
          h('button', { className: `${NS}-btn`, onClick: selectAllMissing, disabled: busy !== null }, '勾选所有缺失'),
          h('button', { className: `${NS}-btn`, onClick: () => setSelected({}), disabled: busy !== null || selectedNames.length === 0 }, '清空勾选'),
          h('button', { className: `${NS}-btn ${NS}-btn-primary`, onClick: onPlan, disabled: busy !== null || selectedNames.length === 0 },
            busy === 'plan' ? '预检中…' : `装回勾选的 ${selectedNames.length} 个`)),

        note !== null ? h('div', { className: note.kind === 'err' ? `${NS}-err` : note.kind === 'warn' ? `${NS}-warn` : `${NS}-ok` }, note.text) : null,
        error !== null ? h('div', { className: `${NS}-err` }, `读取失败：${error}`) : null,

        // 确认面板：预检结果先摊开给用户看，确认后才真的装。
        plan !== null ? h('div', { className: `${NS}-plan` },
          h('div', { className: `${NS}-row` },
            h('strong', null, '确认要装回这些？'),
            h('span', { className: `${NS}-muted` }, '已逐个检查过来源是否可用')),
          (plan.planned ?? []).map(item => h('div', { key: item.packageName, className: `${NS}-row` },
            h('span', { className: item.status === 'ready' ? `${NS}-ok` : `${NS}-err` }, item.status === 'ready' ? '可装' : '装不了'),
            h('span', { className: `${NS}-name` }, item.packageName),
            h('span', { className: `${NS}-spec` }, item.spec ?? ''),
            item.reason ? h('span', { className: `${NS}-muted` }, item.reason) : null)),
          (plan.unknown ?? []).length > 0 ? h('div', { className: `${NS}-warn` }, `历史里没有这些名字：${(plan.unknown ?? []).join('、')}`) : null,
          h('div', { className: `${NS}-row` },
            h('button', { className: `${NS}-btn ${NS}-btn-primary`, onClick: onConfirm, disabled: busy !== null || !(plan.planned ?? []).some(item => item.status === 'ready') },
              busy === 'install' ? '安装中…' : '确认装回'),
            h('button', { className: `${NS}-btn`, onClick: () => setPlan(null), disabled: busy !== null }, '取消'))) : null,

        visible.length === 0
          ? h('div', { className: `${NS}-empty` }, loading ? '读取中…' : rows.length === 0 ? '还没有记录。装一个插件就会出现在这里。' : '没有符合条件的记录。')
          : h('div', { className: `${NS}-scroll` },
            h('table', { className: `${NS}-table` },
              h('thead', null, h('tr', null,
                h('th', null, ''),
                h('th', null, '插件'),
                h('th', null, '版本'),
                h('th', null, '装过的设备'),
                h('th', null, '最近安装'),
                h('th', null, '来源'),
                h('th', null, '状态'))),
              h('tbody', null, visible.map(row => h('tr', { key: row.key },
                h('td', null, row.present !== true && row.reinstallable === true
                  ? h('input', {
                    type: 'checkbox',
                    checked: selected[row.packageName] === true,
                    onChange: event => setSelected({ ...selected, [row.packageName]: event.target.checked }),
                  })
                  : null),
                h('td', null,
                  h('div', { className: `${NS}-name` }, row.packageName),
                  h('div', { className: `${NS}-spec` }, row.installSpec ?? row.key)),
                h('td', null, (row.versions ?? []).length === 0 ? '—' : (row.versions ?? []).slice(0, 3).join(', ')),
                h('td', null, (row.devices ?? []).map(device => h('span', {
                  key: device.deviceId,
                  className: `${NS}-tag${device.deviceId === here ? ` ${NS}-tag-here` : ''}`,
                  title: `${device.deviceId} · ${fmt(device.at)}`,
                }, device.deviceId === here ? '本机' : (deviceLabels.get(device.deviceId) ?? device.deviceId.slice(0, 8))))),
                h('td', null, fmt(row.lastInstalledAt ?? row.latestAt)),
                h('td', null, h('span', { className: `${NS}-tag ${NS}-tag-none` }, row.sourceType ?? '未知')),
                h('td', null,
                  row.present === true
                    ? h('span', { className: `${NS}-ok` }, `本机已装${row.presentVersion ? ` ${row.presentVersion}` : ''}`)
                    : row.reinstallable === true
                      ? h('span', { className: `${NS}-tag-missing` }, '本机缺失')
                      : h('span', { className: `${NS}-muted` }, '本机缺失（本地安装，无法复现）'))))))),
      )
    }

    /** 我那一个 bundle 页上的卡片：直接复用主面板，避免两处逻辑分叉。 */
    function BundleCard(ownerProps) {
      // 契约里这个座位只在 bundle 页的 page 视图渲染；summary 视图交给宿主自己的描述。
      if (ownerProps !== undefined && ownerProps !== null && ownerProps.view === 'summary') return null
      return h(HistoryPage)
    }

    /**
     * 客户端插件本体。
     * @param {any} ctx 客户端上下文。
     * @returns {() => void} 释放函数。
     */
    function apply(ctx) {
      const slots = ctx.slots
      const disposers = []
      const style = document.createElement('style')
      style.dataset.dshHistory = '1'
      style.textContent = CSS
      document.head.appendChild(style)

      // 附图1：Plugins 设置区里的「历史安装」页签。
      disposers.push(slots.inject('settings.plugins.tab', () => slots.register(
        { name: 'settings.plugins.tab', id: 'history', order: 60, label: '历史安装' },
        HistoryPage,
      )))
      // 附图2：设置左侧导航里的「历史插件」页。
      disposers.push(slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'history', order: 45, label: '历史插件 History' },
        HistoryPage,
      )))
      // 自己 bundle 页上的卡片（按包名 keyed）。
      disposers.push(slots.inject('plugins.bundle.config', () => slots.register(
        { name: 'plugins.bundle.config', key: 'dsh-history-plugin' },
        BundleCard,
      )))

      return () => {
        try {
          style.remove()
        } catch {
          /* 已经被移走了 */
        }
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 重复释放是无害的 */
          }
        }
      }
    }

    return { name: 'dsh-history-plugin', inject: ['slots'], apply }
  },
})
