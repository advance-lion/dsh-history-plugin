# dsh-history-plugin

插件安装历史：**本机记账 → 按设备归类 → 经百度网盘跨设备同步 → 勾选批量重装**。

DeepSeek 账号不参与身份识别、授权或同步；**网盘授权本身决定能访问哪份历史**，
同一个网盘账号即同一份历史，换账号不会串数据。
历史的含义是「曾成功安装」，不是「现在已安装」——卸载后记录仍然保留。

## 文档入口

仓库内 `docs/` 是设计与授权事实的唯一权威副本；不要再引用仓库外的计划稿或工作目录。

- [实现方案](docs/implementation-plan.md)：设计目标、边界和验收条件。
- [百度授权链路实测](docs/baidu-authorization-chain.md)：体验授权的真实链路、风险与正式授权要求。
- [实现现状与设计差异](docs/implementation-status.md)：当前代码相对设计目标的差异和待办。

本文描述当前实现行为。与授权有关的两条硬约定：正式发布使用自己的百度应用走授权码
或设备码流程并保存 `refresh_token`；公开演示应用只用于零注册的「限时体验」，回调只能是 `oob`。
DSH Desktop 中，客户端在插件自己持有的 guest webview 里打开百度授权页，只读取该页面的
成功地址并把原文交给 Host；非 Desktop 或 bridge 不可用时才回退到剪贴板读取。
Host 校验 `state`、提取 token 并保存；界面不提供 token 输入框，也不回显 token。

## 数据模型

每台设备只写自己的那一份 JSON，读取时合并成一张历史表。这样比共写一个
`history.json` 稳妥：网盘没有本功能可用的原子比较写入，共写会互相覆盖。
用户看到的是一份统一历史，底层可以是多份很小的文件。

```jsonc
{
  "schemaVersion": 1,
  "deviceId": "随机 UUID（首次运行生成，不采集任何硬件信息）",
  "deviceLabel": "我的笔记本",          // 用户自定义显示名，可空
  "updatedAt": "2026-10-13T00:00:00.000Z",
  "entries": [
    {
      "eventId": "…",                   // 跨设备合并按它去重
      "kind": "installed",              // installed | discovered
      "key": "registry:dsh-example-plugin@1.2.3",  // 跨设备匹配的归一化键
      "packageName": "dsh-example-plugin",
      "version": "1.2.3",
      "installSpec": "dsh-example-plugin@1.2.3",
      "sourceType": "registry",         // registry | git | tarball | local
      "reinstallable": true,
      "installedAt": "2026-10-13T00:00:00.000Z",
      "deviceId": "…",
      "provenance": "install-result"    // install-result | market-log | profile-scan
    }
  ]
}
```

### 两个字段的语义，决定了整个采集逻辑

- **`kind: "discovered"`**：从现存配置补录，**只有 `observedAt`**。
  扫描无法证明真实安装日，所以绝不伪称安装时间，UI 标为「首次发现」。
- **`provenance`**：证据强度。`market-log`（市场自己写的日志，带真实时间戳）、
  `install-result`（plugin-manager 成功结果）可信；`profile-scan` 是补录。

### 安装来源归一化

同一个插件在 profile 里可能是四种形态，跨设备匹配必须先归一到同一个 key：

| 依赖形态 | sourceType | key | 可重装 |
|---|---|---|---|
| `1.2.3` / `^1.2.3` | registry | `registry:<name>@<确切版本>` | 是 |
| `github:o/r#sha` | git | `git:github.com/o/r#sha` | 是 |
| `https://…/tar.gz/x` | tarball | `tarball:<host>/<path>` | 是 |
| `link:C:/…` / `file:` | local | `local:<name>@<version>` | **否** |

- git 的四种写法（`github:o/r#ref`、`git+https://…`、`https://github.com/o/r#ref`、裸 `o/r#ref`）
  归一到**同一个 key**。
- 用户信息（`user:token@`）、查询串、私有仓库凭据一律剥离，**绝不进云文件**。
- 本机路径只记包名与版本，路径本身不入云（每台机器的盘符都不同）。
- `local` 来源**不可重装**（别的机器上没有那个目录），预检时就如实标为装不了。

## 采集规则

`listBundles()` 的字段语义就是过滤规则：

```js
installed === true && removable === true && name !== 'dsh-history-plugin'
```

- `installed`：包在 profile 的 `dependencies` 里（**真正装过**；仅启用不算）
- `removable`：不是 DSH installation 自带的包（天然排除预装与官方 bundle）

事件来源按可信度从高到低：

1. **实时**：`plugin-manager/changed` 只是一个信号——载荷**只有 `{reason}`，不带 diff**，
   所以每次收到都要回读 `listBundles()` + profile `package.json` 做 diff。
2. **补录**：启动时扫一次现存外部 bundle。历史里有、上次快照没有 → 重装；
   历史里完全没有 → 首见（`discovered`）。
3. **升级可信度**：市场日志 `.dsh-market/log.ndjson` 里 `exit=0` 的安装行带真实时间戳，
   凡被它覆盖的包一律用它的事件（真实安装日期），不再退化成「首见」。失败的 `exit=1` 不入历史。

**幂等性**：补录事件用**内容派生**的 `eventId`，重复解析只会收敛成一条；
实时事件（真实安装/重装/升级）用随机 `eventId`，每次都是独立事实。
`loadHistory()` 会做一次**去重压缩**并写回，因此旧版本留下的重复条目能自愈。

### 批量重装

确认之前先**预检**（`inspect(spec)` 逐个问 plugin-manager 能不能装），把结果摊开给用户看，
确认后**串行** `installBundle`——串行是有意的：并发安装会抢同一把 profile 写锁。

读结果只看 `application`，不看 `installBundle` 的返回是否有 `status`：
`applied` / `restart-required` 才算成功，`restart-required` 会如实告诉用户「需要重启 DSH」。
`bundle-in-use`、`ambiguous-install` 会退避重试三次；其余错误直接报告，不假装成功。

## 云同步（百度网盘）

远端结构：

```
/dsh-history-plugin/
  location.json                 # 指针：当前 schemaVersion 写在哪个子目录
  v1/replicas/<deviceId>.json   # 每台设备一份，互不覆盖
```

- **不做读-改-写合并**。每台设备只写自己那份文件，读取时把全部副本拉下来合并成一张表。
  网盘没有可用的原子比较写入，共写必然互相覆盖。
- **没有记录的设备不算一台设备**：新机器还没装过任何插件时，它那份文档是空的，
  合并视图里就不该出现「设备 B · 0 条」，否则新机器一拉取就谎报设备数。
- 远端 JSON 一律按**不可信输入**校验：超长字段、路径穿越、异常 spec、未知 schema
  全部拒收并计入 `skipped`，一份坏文件不会毁掉整次同步。
- `location.json` 在**首次使用某个目录时**写下（已有指针绝不覆盖），声明副本目录与
  schema 版本，读它就能支持「云端目录被移动过」。写入端与读取端都在传输层。

### 百度网盘接口上踩到的坑（都已按实测行为处理）

1. **`rtype` 不可靠**。`rtype=1` 建目录会**静默**建出一个带时间戳的同级目录，
   `rtype=2` 覆盖会变成 `name(1).json`。**一律 `rtype=0`**，更新走「先删再建」。
2. **列目录里的 `md5` 不是内容 md5**，而是百度自己的签名（实测含字母 `v`，不是合法十六进制）。
   早先按它校验导致真实下载全部「校验失败」——实际上传与下载字节**完全一致**，本地 md5 也对得上。
   现在只校验**字节数与列目录一致**，完整性靠严格的 schema 校验 + JSON 解析。
   该签名仍原样保留但标注为不可信。
3. **删除的响应无法区分「删掉了」与「本来就不存在」**（`info` 列表都是空的）。
   所以删除前先列一次目录，只有确实存在过才报 `removed: true`——宁可多一个请求，也不谎报。
4. 所有请求都要带 `User-Agent: pan.baidu.com`，否则接口行为怪异。
5. 分片上传的响应不是 JSON（`not found` 之类），**必须按 `/rest/2.0/pcs/superfile2` 先匹配**，
   否则会被当成下载响应去解析。
6. 下载完一定要 `response.clone()`，否则「先读 body 再解析」会撞 `TypeError: Body is unusable`。

### 授权：三条路，先说清代价

| | 需要什么 | 能否扫码 | 会不会自己过期 |
|---|---|---|---|
| **百度演示应用一键授权（限时体验）** | 不需要注册应用，直接用百度官方 MCP 文档里的公开演示 `client_id` | **能**——授权页就是百度登录页，那一页可以扫码登录 | 会：隐式流程只给 access token，没有 `refresh_token`；百度官方也说明体验入口仅供测试、密钥可能变更 |
| **自己的百度应用（OAuth 授权码）** | 在百度开放平台注册一个应用，拿 AppKey/SecretKey + 登记回调地址 | **能**——授权页就是百度登录页，那一页可以扫码登录 | 不会：拿得到 `refresh_token`，过期前自动换新的 |
| 导入临时 access token | 开放平台控制台里签发一个临时 token，仅保留给环境变量或旧凭据导入 | 不涉及 | 会：过期后要重新授权 |

**零注册路径（云同步卡片里的「连接百度网盘」）**：百度给那个公开演示应用只登记了
`redirect_uri=oob`，所以授权成功后浏览器会停在
`https://openapi.baidu.com/oauth/2.0/login_success#access_token=…`，token 只在地址栏片段里，
不会自动回跳到本机。

在 DSH Desktop 里，授权页直接运行在插件申请的 guest webview 中。客户端监听这个 webview 的
`did-navigate`、`did-navigate-in-page` 和 `did-stop-loading`，命中成功页后读取 `getURL()`，
把整条地址和本次 `state` 交给 Host，随后立即销毁页面并释放宿主分区。用户登录并点「授权」后
会自动保存，不需要复制或粘贴。它只读取这一个插件所有的 guest，不碰其他浏览器标签、Cookie
或后台剪贴板；界面不解析、不回显、不持久化 token。

授权面板是设置页里**最上层的独立模态**：它挂在设置弹窗自己的遮罩容器里，层级高于设置遮罩，
键盘归属也归它（Escape 取消授权，Tab 不落到后面的设置页）。页面加载失败或迟迟没有可用导航时
如实报错并回退到剪贴板路径，不会把按钮停在「授权中…」。

非 Desktop 宿主或 browser bridge 协议不可用时，才回退到原来的兼容路径：用户在成功页按
`Ctrl+L`、`Ctrl+C` 复制整条地址，再切回 DSH；连接会话有效且窗口获得焦点或恢复可见时，
客户端读取剪贴板，只检查它像不像百度成功页地址，命中后把原文交给 Host。若 DSH 拒绝剪贴板权限，
界面会明确提示并允许重试。演示体验只给 access token，不提供 `refresh_token`；正式发布要走
下面「自己的应用」，才能自动续期。

**自己的应用（授权码流程）**：扫码本身不是难点，难点在 OAuth 里客户端身份不能匿名——
授权页得先知道「哪个应用在请求授权」。所以顺序是：注册应用 → 填 AppKey/SecretKey/回调地址 →
打开授权页（在那里扫码登录）→ 把回调地址整条 URL 粘回来换 token。

界面上的流程（云同步卡片里折叠的「用百度账号授权」）：

1. 填 AppKey / SecretKey / 回调地址 → **打开授权页**（新标签打开 `openapi.baidu.com/oauth/2.0/authorize`）
2. 在那一页登录（可扫码）并同意授权 → 浏览器跳到你的回调地址
3. 回调地址如果没指向本插件的本机回调页就会打不开，**把地址栏里的整条 URL 粘回「授权码」框**即可；
   只粘 `code` 参数也认（`extractCode` 两种都解）。若登记的是本插件的 `/oauth/redirect`，页面会自己把 code/token 交回来。

应用凭据与 token 存在**同一条**凭据记录里，且只在换取成功时一起落盘——不留「填了 AppKey
但没有 token」的半配置状态。凭据放在这里而不是插件配置里：插件配置是 profile 下的明文文件。
环境变量或旧凭据导入的临时 token 与凭据记录合并保存，不会抹掉已有刷新信息。

Token 只存在于宿主的凭据记录 `dsh-history-plugin/baidu-netdisk`（`kind: 'grant'`）。
**绝不写进历史文件、日志、错误消息或任何 HTTP 响应**；`GET /status` 只回答
「配没配、能不能写」，从不回传值。所有对外消息都过 `redactToken` / `redactUrl`。

刷新的判断规则（`lib/oauth.js`）：

- `expiresAt` 为空（例如环境变量给的临时 token）→ **不主动刷新**：没有依据就不动它
- 距过期不足 10 分钟 → 用 `refresh_token` 换新的；端点没回新 `refresh_token` 时**沿用旧的**
- 刷新失败但还没过期 → 只告警，继续用当前 token（多一次成功同步比多一次误报有用）
- **已过期且刷不出来** → 同步直接停下并报「授权已过期，请重新授权」，而不是拿废 token 去撞墙

token 端点的参数名是**实测确认**的：用一个不存在的 client_id 打过去，返回
`401 {"error":"invalid_client"}`，说明端点存在且认 `grant_type` / `client_id` / `client_secret`，
并且 GET + 查询串就能送达参数（它读出了 client_id 才报 unknown client）。
`/oauth/2.0/device/code` 实测返回 200，并能取得设备码；但演示应用拿不到可用的
`client_secret`，换 token 时会被百度按缺少必需参数拒绝。因此设备码在**有正式 client 凭据时**
可以完全自动轮询并回写 token，但它不是零注册方案，当前也没有实现设备码轮询。

## 界面

两个入口都按宿主槽位契约选择，**刻意不用 `plugins.item`**——那个座位在契约里写的是
「Plugins 页 Official 分组里列出的**官方**插件卡片」，被官方设置页占着，第三方占它只会搞乱列表。

| 附件里的目标 | 槽位 | 说明 |
|---|---|---|
| 附图 1「历史安装」页签 | `settings.plugins.tab` | 与宿主自己的页签并排，`{ id, order, label }` |
| 附图 2「历史插件」设置项 | `settings.section` | 设置左侧导航里的独立设置页 |
| 插件自己的 bundle 页卡片 | `plugins.bundle.config` | 按包名 keyed，只在该 bundle 的页面渲染 |

三个入口渲染的是**同一个组件**，避免两处逻辑分叉给出不同答案。
注册一律走 `slots.inject(slot, () => slots.register(...))`：槽位不存在时**静默失联**，
`inject` 会等它出现，所以老版本宿主上宁可什么都不注册，也不会「注册成功但界面里没有」。

样式只用主题变量（`--dsw-alias-*`），明暗主题自动跟随，没有硬编码色值。
默认连接流程不提供 token 输入框；高级路径的 SecretKey 使用 `password` 类型。
界面**不碰** `localStorage` / `sessionStorage`。

## 宿主 HTTP 接口

前缀 `/dsh-history-plugin/api/v1`，**每个路径只注册一条路由**（`/credential` 同时有
POST 与 DELETE，同路径注册两次会被后注册的覆盖，所以方法在内部区分）。

```
GET    /status       设备、凭据状态、同步状态
GET    /history      合并后的历史表
GET    /devices      各设备与其条目数
POST   /sync         立即拉取 + 推送
POST   /reinstall    预检（dryRun）或执行批量重装
POST   /credential   保存 access token
DELETE /credential   清除授权
POST   /oauth/authorize-url  拼授权页地址（响应不含 SecretKey）
POST   /oauth/callback       用授权码换 token 并保存
POST   /storage-test         测试云端目录读写（写探针→逐字节读回→删除）
POST   /device       改设备显示名
```

四层防护，顺序固定：

1. **宿主闸门**：每个请求先问 `ctx.get('connection')?.requestRejection(request)`。
   返回 `403` / `401` 就照抄返回；**闸门抛异常一律当 403（失败即关闭）**。
2. **方法**：不匹配返回 `405` 并带 `allow`。
3. **同源**：改动类请求必须同源。Host 必须是回环地址或宿主声明的 authority
   （防 DNS rebinding），拒绝 `sec-fetch-site: cross-site`，拒绝 `Origin: null` /
   空 / 解析不了；**允许没有 Origin**（桌面端代理会剥掉它）。
4. **请求体**：上限 16 KiB，超限 `400`。

## 文件位置

| 内容 | 路径 |
|---|---|
| 设备身份 | `$DSH_HOME/history-plugin/device.json` |
| 本机账本 | `$DSH_HOME/history-plugin/history.json` |
| 采集快照 | `$DSH_HOME/history-plugin/state.json` |
| 诊断日志 | `$DSH_HOME/history-plugin/plugin.log` |
| 远端副本缓存 | `$DSH_HOME/history-plugin/accounts/<网盘账号>/remote.json` |
| 网盘授权 | 宿主凭据记录 `dsh-history-plugin/baidu-netdisk` |

本机数据放在插件自己的 `$DSH_HOME` 子目录，不写 profile 目录——profile 归
plugin-manager 的写锁管，插件往里塞文件会跟 pnpm 与 HMR 抢同一个目录。
远端缓存按**网盘账号分目录**，换账号不会读到上一个账号的残留。

## 开发

```bash
node scripts/smoke.mjs          # 106 项：归一化 / 校验 / 目录收敛 / 临时文件清扫 / 过滤 / 补录 / 幂等 / 采集器集成
node scripts/baidu-smoke.mjs    # 70 项：网盘传输 + 测试读写探针 + 目录迁移（自带假网盘，含「签名不可信」「下载被截断」「非空目录拒删」）
node scripts/sync-smoke.mjs     # 51 项：跨设备合并 / 截断 / 坏文件 / 换账号隔离 / 待推送
node scripts/host-smoke.mjs     # 85 项：真实 apply() + 假 Cordis 上下文：路由 / 闸门 / 同源 / 凭据不外泄 / 重装 / OAuth 守卫
node scripts/client-smoke.mjs   # 59 项：真实求值 client.js：槽位注册 / Desktop webview 读回 / 覆盖层层级与键盘归属 / 剪贴板回退 / 不碰 storage
node scripts/oauth-smoke.mjs    # 69 项：OAuth 协议与刷新（自带假授权服务器：参数 / 错误转述 / 该不该刷 / 密钥不外泄）
node scripts/authflow-smoke.mjs # 40 项：演示应用回调必须是 oob / 成功页 token 提取 / 一次性会话
node scripts/ledger-report.mjs  # 只读预演：用真实 profile 在临时 DSH_HOME 里跑一遍，打印账本
node scripts/lint-text.mjs      # 文本完整性：编码损坏 / 控制字符 / JSON 可解析

# 真实网盘（需要 BAIDU_TOKEN_FILE 指向一个含 token 的文件；未设置则自动跳过）
node scripts/baidu-live.mjs       # 12 项：传输层（增删读写幂等、不留副本文件与副本目录）
node scripts/two-device-live.mjs  # 50 项：两台设备端到端（A 推 → B 拉 → B 推 → A 拉 → 离线补传）
```

全部离线套件共 **480 项断言**，真实网盘另有 **62 项**。除两个 `*-live.mjs` 外都不联网，
且都把 `DSH_HOME` 指向临时目录——**测试绝不触碰真实账本**。`ledger-report.mjs` 只读真实
profile，不写线上账本。`two-device-live.mjs` 刻意用独立的远端目录
`/dsh-history-plugin-livetest`，收尾整个删掉，绝不往真实目录塞测试数据。

### ⚠️ 两个必须知道的操作事实

1. 本插件以 `link:` 方式安装时，**改 `lib/*.js` 的代码不会热更新**：Node ESM 按真实路径
   缓存模块，bundle 停/启只会重新挂载 fiber，拿到的还是缓存里的旧模块。改完代码要
   **重启 DSH** 才生效（只改 `cordis.patch.yml` 之类的配置才会 HMR 立即生效）。
   连改 `package.json` 新加 `dsh.client` 也要重启，客户端入口是启动时读的。
2. 插件必须**先装上**才能在界面里看到历史——新机器上这是个死循环。缓解办法是
   导出/导入，或直接粘贴一条安装命令。

## 安全姿态

- 不采集硬件序列号 / MAC / 主机名；设备 ID 是纯随机 UUID。
- 云文件只存重新安装所需的最小信息：不写下载路径、完整配置、密钥、对话。
- 远端 JSON 一律按**不可信输入**校验；单份文件 1 MiB、单份事件 5000 条上限，超出按
  最新优先截断并写下 `truncated` 说明。
- 日志不输出 access token、dlink 或含凭据的安装 spec。
- HTTP 接口不返回 token，不返回本地路径；被闸门拒绝时不返回任何数据。

## 尚未实现

- **真实应用下的 OAuth 端到端**：协议部分（拼授权页 URL / 授权码换 token / 刷新 / 该不该刷）
  已有 69 项离线断言，但**没有 AppKey 就走不通真实授权**，所以「真实授权页 → 真实 code →
  真实 token」这一段**未经实测**，只是按实测确认过的端点与参数实现。拿到 AppKey 后要补一次真实验证。
- **真实 Desktop 授权端到端**：Client 已动态加载 webview 回读实现，离线断言覆盖 bridge 版本、
  lease/partition、导航事件、`getURL()` 与剪贴板回退；但还没有在真实 DSH Desktop 界面完成
  百度登录、授权、自动保存和账号读取。
- **设备码轮询**：`device/code` 端点可用，但公开演示应用缺少换 token 所需的非空 `client_secret`，
  不能靠它实现零注册。若正式应用获准设备码且项目方能安全持有客户端凭据，再补轮询实现。
- **网盘网页版扫码（Cookie 路线）**：不需要注册应用、立刻可扫码，但走的是 `pan.baidu.com`
  的**非官方**内部接口，百度可随时改动，且第三方客户端有被风控/限制账号的风险。刻意不做，
  除非明确要求。
- **冷启动引导**：新机器上要先装插件、再授权网盘，才看得到历史。缓解办法是导出/导入，
  或直接给一条可粘贴的安装命令。
