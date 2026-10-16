/**
 * 客户端半边测试：在没有浏览器、没有 GUI 的情况下验证 client.js。
 *
 * 做法是把它放进一个最小的客户端运行时里真实求值：
 *   - 假 `window.__ModuleLoader__` 捕获 `load({ id, factory })`
 *   - 假 `react`（只够跑通函数组件与 hooks）
 *   - 假 `ctx.slots` 捕获每一次注册
 *
 * 这样能抓住真正会让人白折腾一轮的问题：槽位名写错、meta 少字段、
 * `apply` 返回的不是释放函数、组件一渲染就抛异常。真实的像素效果仍需在 GUI 里看。
 *
 * 用法：node scripts/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, '..', 'client', 'client.js')
const source = readFileSync(clientFile, 'utf8')

let passed = 0
let failed = 0
const section = title => console.log(`\n== ${title} ==`)
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/* -------------------------------------------------- 最小的客户端运行时 */

/** 捕获 load 的载荷。 */
const loaded = []
/** 假的样式元素。 */
const styles = []
globalThis.window = {
  __ModuleLoader__: {
    load: spec => {
      loaded.push(spec)
    },
  },
}
globalThis.document = {
  createElement: () => ({
    dataset: {},
    style: {},
    textContent: '',
    remove() {
      this.removed = true
    },
    removed: false,
  }),
  head: {
    appendChild: element => {
      styles.push(element)
    },
  },
}

/** 够用的 react 替身：createElement + 三个 hooks。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type: typeof type === 'function' ? type.name || 'anonymous' : String(type),
    props: props ?? {},
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
    // 保留原始类型，方便直接调用函数组件。
    raw: type,
  })
  return {
    createElement,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: fn => fn,
    useEffect: () => {},
    useRef: initial => ({ current: initial }),
  }
}

const React = makeReact()
const requireStub = name => {
  if (name === 'react') return React
  throw new Error(`客户端不该 require "${name}"：它只能依赖 shell 的共享 external`)
}

await import(`file://${clientFile.replaceAll('\\', '/')}`)

/* ------------------------------------------------------------ 模块契约 */
section('模块加载契约')
{
  check('调用了 window.__ModuleLoader__.load', loaded.length === 1, String(loaded.length))
  check('id 与包名一致', loaded[0]?.id === 'dsh-history-plugin', String(loaded[0]?.id))
  check('提供了 factory', typeof loaded[0]?.factory === 'function')

  const plugin = loaded[0].factory(requireStub)
  check('factory 返回插件对象', plugin !== null && typeof plugin === 'object')
  check('插件名正确', plugin.name === 'dsh-history-plugin', String(plugin.name))
  check('声明 inject: [slots]', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
  check('有 apply', typeof plugin.apply === 'function')

  const snapshot = { plugin }
  globalThis.__snapshot = snapshot
}

/* ------------------------------------------------------------ 槽位注册 */
const plugin = globalThis.__snapshot.plugin
section('槽位注册（附图1 / 附图2）')
{
  const injections = []
  const registrations = []
  const disposers = []
  let disposed = 0
  const ctx = {
    slots: {
      inject(name, callback) {
        injections.push(name)
        const off = callback()
        return typeof off === 'function' ? off : () => {}
      },
      register(meta, component) {
        registrations.push({ meta, component })
        return () => {
          disposed += 1
        }
      },
    },
  }

  const release = plugin.apply(ctx)

  check('只对三个槽位做了 inject', injections.join(',') === 'settings.plugins.tab,settings.section,plugins.bundle.config', injections.join(','))
  check('三个槽位都注册成功', registrations.length === 3, String(registrations.length))

  const tab = registrations.find(item => item.meta.name === 'settings.plugins.tab')
  check('附图1：注册到 settings.plugins.tab', tab !== undefined)
  check('附图1：id 必填字段存在', typeof tab?.meta.id === 'string' && tab.meta.id !== '', JSON.stringify(tab?.meta))
  check('附图1：页签标签是历史安装', tab?.meta.label === '历史安装', String(tab?.meta.label))
  check('附图1：给了 order', typeof tab?.meta.order === 'number', String(tab?.meta.order))
  check('附图1：渲染的是函数组件', typeof tab?.component === 'function')

  const nav = registrations.find(item => item.meta.name === 'settings.section')
  check('附图2：注册到 settings.section', nav !== undefined)
  check('附图2：id 必填字段存在', typeof nav?.meta.id === 'string' && nav.meta.id !== '', JSON.stringify(nav?.meta))
  check('附图2：标签含历史插件', String(nav?.meta.label).includes('历史插件'), String(nav?.meta.label))
  check('附图2：与页签用的是同一个组件（两处逻辑不分叉）', nav?.component === tab?.component)

  const bundleCard = registrations.find(item => item.meta.name === 'plugins.bundle.config')
  check('bundle 卡片：注册到 plugins.bundle.config', bundleCard !== undefined)
  check('bundle 卡片：keyed 槽位按包名 keyed', bundleCard?.meta.key === 'dsh-history-plugin', String(bundleCard?.meta.key))
  check('bundle 卡片：没有误用 plugins.item（那是官方插件的座位）', !registrations.some(item => item.meta.name === 'plugins.item'))

  check('apply 返回释放函数', typeof release === 'function')
  check('注入了样式但只有一份', styles.length === 1, String(styles.length))
  release()
  check('释放时撤销了所有注册', disposed === 3, String(disposed))
  check('释放时移除了样式', styles[0]?.removed === true)
}

/* ---------------------------------------------------------------- 渲染 */
section('渲染')
{
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (meta, component) => {
        registrations.push({ meta, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const HistoryPage = registrations.find(item => item.meta.name === 'settings.plugins.tab').component
  const BundleCard = registrations.find(item => item.meta.name === 'plugins.bundle.config').component

  let tree = null
  let renderError = null
  try {
    tree = HistoryPage()
  } catch (error) {
    renderError = error
  }
  check('主面板能渲染不抛异常', renderError === null, renderError === null ? '' : String(renderError))
  const text = JSON.stringify(tree)
  check('渲染出标题「历史安装」', text.includes('历史安装'))
  check('渲染出同步按钮', text.includes('同步网盘'))
  check('渲染出云同步分区', text.includes('云同步'))
  check('渲染出设备名输入', text.includes('本机设备名'))
  check('渲染出筛选按钮', text.includes('本机缺失') && text.includes('可装回'))
  check('渲染出批量装回动作', text.includes('装回勾选的'))
  check('未授权时同步按钮禁用', JSON.stringify(tree).includes('"disabled":true'))
  // 首次渲染时数据还没回来，显示的应当是「读取中」而不是空态。
  check('首次渲染显示读取中', text.includes('读取中'), text.slice(0, 200))
  check('源码里有空态文案（数据回来后显示）', source.includes('还没有记录'))
  check('一键授权会自动读取百度成功页地址', source.includes('navigator.clipboard.readText') && source.includes('login_success') && source.includes('oauth/callback'))
  check('一键授权不再要求手动点完成连接', !source.includes("'完成连接'") && !source.includes('授权结果'))
  check('剪贴板只在窗口聚焦且连接会话有效时读取', source.includes('document.hasFocus') && source.includes("addEventListener('focus'") && source.includes('connectDraft === null'))
  check('窗口恢复可见时也会自动读取剪贴板', source.includes("addEventListener('visibilitychange', onFocus)") && source.includes("removeEventListener('visibilitychange', onFocus)"))
  check('剪贴板权限失败会提示而不是静默卡住', source.includes('clipboard.ok !== true') && source.includes('DSH 尚未放行剪贴板读取'))

  // 桌面宿主（桥协议版本 1）：授权页跑在插件自己持有的 guest webview 里，直接读回地址。
  check('只认协议版本 1 的桌面浏览器桥', source.includes('carrier.protocolVersion !== 1') && source.includes('typeof browser.acquire !== '))
  check('桌面路径用宿主发放的 guest 读回成功页', source.includes("createElement('webview')") && source.includes('element.loadURL(options.authorizeUrl)') && source.includes('element.getURL()'))
  check('guest webview 按宿主约定带 lease 与 partition', source.includes("setAttribute('name', reservation.lease)") && source.includes("setAttribute('partition', reservation.partition)") && source.includes('`about:blank#${reservation.lease}`'))
  check('导航事件齐全（含同页跳转）', source.includes("'did-navigate', 'did-navigate-in-page', 'did-stop-loading'"))
  check('读到地址后释放宿主分区', source.includes('bridge.release(id)') && source.includes('overlay.remove()'))
  check('拿不到桌面桥时仍保留剪贴板回退', source.includes('if (bridge === undefined || authorizeUrl === \'\')') && source.includes('setConnectDraft({ state, expiresAt })'))

  // 覆盖层必须盖过设置弹窗：宿主那层遮罩是 z-index 1000，插件原来用 60 会被压在下面，
  // 表现为「按钮变成授权中，但看不到登录页」。
  const overlayZ = Number(/\.\$\{NS\}-auth-overlay \{[^}]*z-index:\s*(\d+)/.exec(source)?.[1] ?? '0')
  check('授权覆盖层 z-index 高于设置遮罩 1000', overlayZ > 1000, String(overlayZ))
  check('覆盖层标注为独立模态（role/aria-modal）', source.includes("setAttribute('role', 'dialog')") && source.includes("setAttribute('aria-modal', 'true')"))
  // 挂载点优先取设置弹窗的遮罩容器，取不到才退回 body。
  check('覆盖层优先挂进设置弹窗容器', source.includes('[data-shortcut-modal="settings"]') && source.includes('settingsDialog.parentElement') && source.includes(': document.body'))
  // Escape / Tab 归覆盖层：设置弹窗的 useModalLayer 会看 defaultPrevented，捕获阶段拦下即可让位。
  check('捕获阶段接管 Escape / Tab 并在卸载时摘掉监听', source.includes("document.addEventListener('keydown', onKeyDown, true)") && source.includes("document.removeEventListener('keydown', onKeyDown, true)"))
  // 加载失败与超时都要走 fail()，交给调用方回退剪贴板，而不是永远停在「授权中…」。
  check('加载失败与超时都走 fail 回退', source.includes('AUTH_LOAD_TIMEOUT_MS') && source.includes("fail('授权页加载超时，')") && source.includes("fail('授权页加载失败，')") && !source.includes("hint.textContent = '页面加载失败"))

  check('bundle 卡片在 summary 视图返回 null', BundleCard({ view: 'summary' }) === null)
  const pageTree = BundleCard({ view: 'page' })
  // `h(HistoryPage)` 返回的是元素本身，函数组件的内容要等 React 渲染时才有；
  // 所以这里断言它复用的**就是同一个组件**，比断言文案更准。
  check('bundle 卡片在 page 视图复用同一个面板组件', pageTree?.raw === HistoryPage, String(pageTree?.raw))
  check('bundle 卡片对未知 props 也能渲染', BundleCard()?.raw === HistoryPage)
}

/* ------------------------------------------------------------ 安全洁癖 */
section('客户端不该碰的东西')
{
  check('不使用 localStorage / sessionStorage 存 token', !/localStorage|sessionStorage/.test(source))
  check('没有 console.log', !/console\.log/.test(source))
  check('高级 SecretKey 输入框用 password 类型', source.includes("type: 'password'"))
  // 只统计真正的代码，别把注释里提到的 require('react') 也算进去。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('只 require react 这一个 external', (code.match(/require\(/g) ?? []).length === 1, String((code.match(/require\(/g) ?? []).length))
  check('样式只用主题变量，不硬编码颜色', !/#[0-9a-fA-F]{6}/.test(code), '发现硬编码色值')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
