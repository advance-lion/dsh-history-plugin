# 实现现状与设计差异

更新时间：2026-10-16

权威设计见 `implementation-plan.md`，百度授权实测见
`baidu-authorization-chain.md`，当前用户可见行为见根目录 `README.md`。

## 已对齐

| 领域 | 设计目标 | 当前实现 |
| --- | --- | --- |
| 本机记账 | 记录“曾成功安装”，卸载不删历史；启动扫描补录 | `lib/collector.js` + `lib/store.js`；支持实时信号、profile 扫描、市场日志升级可信度 |
| 跨设备模型 | 每台设备只写自己的 `<deviceId>.json`，读取时合并 | `lib/sync.js`；按 `eventId` 去重，按包聚合 |
| 云端布局 | `/dsh-history-plugin/` 固定入口 + `location.json` 目录指针 | `lib/baidu.js`；支持默认目录、指针解析、迁移核心逻辑 |
| 远端校验 | 单份文件大小、schema、路径穿越、凭据泄漏都按不可信输入处理 | `lib/sync.js` + `lib/store.js`；坏文件跳过并计入 `skipped` |
| 凭据存储 | token / refresh token 存 Host 安全凭据，Client 不持有 | `lib/credentials.js`；HTTP 状态只返回配置状态和账号显示名。Desktop oob 路径由插件自有 guest webview 读取成功页原文，Client 不解析、不回显、不持久化；Host 负责校验 `state` 和提取 token。非 Desktop 才走剪贴板回退 |
| 账号隔离 | 同一网盘账号一份历史；换账号不能串缓存 | `lib/sync.js` 按 `uk` 隔离本地远端缓存；授权后尽量写入 `uk` |
| 批量重装 | 先 `inspect`，再串行 `installBundle`，不绕过 DSH 原生流程 | `lib/install.js` |
| UI 槽位 | 设置项与插件页入口使用公开槽位，不占官方分组卡片 | `client/client.js`；使用 `settings.section`、`settings.plugins.tab`、`plugins.bundle.config` |

## 设计差异

| 差异 | 设计目标 | 当前实现 | 处理状态 |
| --- | --- | --- | --- |
| 正式 OAuth 与体验 OAuth 并存 | 正式发布只使用自己的百度开放平台应用，令牌可刷新；零注册体验不需要每个用户注册应用 | 代码已实现自己的应用授权码换 token / refresh token；同时保留公开演示应用的零注册体验路径 | 体验路径只能处理 `redirect_uri=oob`；正式应用真实授权流程尚无 AppKey，未做真实端到端验证 |
| 演示应用回调 | 设计文档把演示应用限定为测试凭据，同时要求普通用户无需重复注册 | DSH Desktop 中，一键连接会强制使用公开演示应用与 `redirect_uri=oob`；授权页运行在插件自己持有的 guest webview 中，Client 监听该 webview 导航并读取 `login_success#access_token=...` 地址，自动交给 Host。授权面板挂在设置弹窗的遮罩容器内，层级高于设置遮罩，键盘归属归它。非 Desktop 或 bridge 不可用时回退为显式复制一次，并在窗口聚焦/恢复可见时读剪贴板 | 2026-10-15 已修复 `redirect_uri_mismatch`，完成自动回传 UI，并把最新 Client bundle 动态加载到 live 插件验证包含 bridge/webview 路径；2026-10-16 修复授权面板被设置弹窗遮罩压住的问题（层级 60 → 高于设置遮罩、挂载点改为设置容器、接管 Escape/Tab、加载失败与超时回退剪贴板）。真实 Desktop UI 中的百度登录与自动保存端到端尚未执行；演示路径也没有 `refresh_token` |
| 设备码流程 | 设计文档允许“授权码/设备码流程” | 当前只实现授权码流程；未实现设备码轮询 | 实测 `GET /oauth/2.0/device/code` 返回 200，并能取得设备码；但演示应用缺少换 token 所需的非空 `client_secret`，会被百度拒绝。因此设备码在**有正式 client 凭据时**可以全自动轮询回写，但不是零注册方案；当前零注册改用插件自有 webview 回读 |
| 网盘写入方式 | 设计文档首选百度网盘 MCP 上传，开放 API 下载 | 当前上传和下载都走百度开放 API：`precreate` / `superfile2` / `create` 与 `filemetas(dlink=1)` | 这是已知实现偏离；需要把“MCP 长期可用性 / 覆盖语义”重新确认后，才能决定是否回到 MCP |
| 设置页安全形态 | 设置页只显示授权状态与重新授权，不提供明文 token 输入框 | 默认体验路径已移除 token 输入框和回显；Desktop 走插件自有 webview 自动回读，非 Desktop 走剪贴板回退。高级折叠区仍保留 AppKey / SecretKey / 授权码输入，用于未完成的正式应用路径 | 明文 access token 入口已收窄；正式发布前仍需把自有应用凭据接入改为不依赖用户手填 SecretKey |
| 自定义云端目录 UI | 设置页可选择/输入网盘文件夹并执行迁移 | 核心传输层和迁移器支持 `remoteDir` / `location.json`，`storage-test` 可测试当前目录；Client 当前只显示目录，没有目录选择和迁移 UI | 部分实现；Host/UI 接线未完成 |
| 主页面顶部页签 | 设计期望在插件主页面顶部增加“历史安装”页签 | 当前按安装版 DSH 实际槽位注册：`settings.plugins.tab`、`settings.section`、`plugins.bundle.config` | 取决于目标 DSH 公开扩展点；没有伪造不存在的槽位 |

## 授权事故与修复记录

事故现象：点击“连接百度网盘”后，百度页报：

```text
错误代码：redirect_uri_mismatch
错误信息：Invalid redirect uri
```

根因：公开演示应用只登记了 `redirect_uri=oob`。旧代码根据 Host / Origin 推导出
`http://127.0.0.1:<port>/dsh-history-plugin/api/v1/oauth/redirect`，交给演示应用后
百度拒绝授权。

修复：`lib/authflow.js` 新增 `DEMO_REDIRECT_URI = 'oob'` 与 `resolveRedirectUri()`；
只要 `client_id` 是公开演示应用，授权页与实际会话记录都强制使用 `oob`。
`lib/index.js` 的 `oauth-session` 不再接受调用方传入的本机回调。

同日又处理了 oob 成功页的手动回传问题：设置页删除了「授权结果」输入框和
「完成连接」按钮。DSH Desktop 现在通过 browser bridge 协议版本 1 创建插件自有的
guest webview，在设置页内完成百度登录；Client 只读取该 webview 的导航地址，命中
`login_success#access_token=...` 后把原文和 `state` 交给 Host。非 Desktop 宿主或桥不可用时，
才回退到“复制一次成功页地址，窗口恢复焦点后自动读剪贴板”。Host 始终负责校验和提取 token。

事故现象（2026-10-16）：点「连接百度网盘」后按钮变成「授权中…」，但看不到百度登录页。

根因：授权覆盖层的 `z-index` 是 60，而宿主设置弹窗的遮罩是 `z-index: 1000`，两者都是
`document.body` 上的 portal，覆盖层被压在设置弹窗下面；同时覆盖层没有登记进宿主的
`useModalLayer`，Escape/Tab 仍归设置弹窗。

修复：覆盖层 `z-index` 提到 2147483000（高于设置遮罩），挂载点优先取
`[data-shortcut-modal="settings"]` 的父容器、取不到才退回 `document.body`；覆盖层标注
`role="dialog"` / `aria-modal="true"`，在捕获阶段接管 Escape（取消授权）与 Tab；主框架
加载失败或 30 秒没有可用导航时走 `fail()` 回退到剪贴板，不再把按钮停在「授权中…」。

验证：

- `node scripts/authflow-smoke.mjs`
- `node scripts/host-smoke.mjs`
- `node scripts/client-smoke.mjs`（59 项，覆盖 bridge 版本守卫、lease/partition、导航读回、覆盖层层级与挂载点、Escape/Tab 归属、加载失败回退与剪贴板回退）
- `npm run smoke:all`
- live 插件已动态加载新 Client bundle revision `488a0bda78ea`；served bundle 包含
  `runDesktopAuthorization`、`dshDesktop`、`webview`、`loadURL`，旧 revision 已返回 404。

## 尚未完成

- 用自己的百度开放平台应用完成一次真实授权码授权，确认 code 换 token、refresh 和账号读取。
- 在真实 DSH Desktop 界面点击「连接百度网盘」，完成百度登录、授权、webview 自动回读和凭据保存的端到端验证。
- 明确正式发布到底采用哪种 OAuth 客户端形态，以及 SecretKey 是否需要可信服务端。
- 如果正式应用获准使用设备码且项目方能安全持有客户端凭据，再实现设备码轮询；当前公开演示应用不能作为零注册设备码凭据。
- 决定 MCP 上传是否恢复；如果继续用开放 API，需要把设计文档里的网盘写入方式升级为已确认方案。
- 把正式自有应用路径改成不需要用户手填 SecretKey，并完成真实回调/刷新验证。
- 把云端目录选择、迁移和诊断从核心逻辑接到设置页。
