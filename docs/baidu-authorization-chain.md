# 百度网盘授权链路：单机实测还原与 DSH 交接

## 结论先说

此前成功的测试**没有注册新百度应用**，使用的是百度网盘官方 MCP 文档给个人用户的限时体验授权入口。用户在浏览器完成登录和授权后，百度把短期 `access_token` 放在成功页面 URL 的 `#` 片段中。百度没有直接把 token 回调给本机服务。

当前插件的零注册路径分两层：

- **DSH Desktop：**Client 通过 browser bridge 协议版本 1 申请一个归插件所有的 guest webview，在设置页内打开百度授权页。授权面板挂在设置弹窗自己的遮罩容器里、层级高于设置遮罩，Escape/Tab 归它，所以登录页看得见、点得到，也不会误关设置页。Client 只监听这个 webview 的导航并读取 `getURL()`；看到 `login_success#access_token=…` 后，把整条地址和本次 `state` 交给 Host。用户不需要复制或粘贴，token 也不会回传给 Client 持久化。页面加载失败或迟迟没有可用导航时如实报错，并退回下面那条剪贴板路径。
- **其他宿主 / bridge 不可用：**在外部浏览器打开授权页，用户显式复制一次成功页地址；Client 只在连接会话有效且窗口获得焦点或恢复可见时读取剪贴板，做成功页地址形状判断后把原文交给 Host。

两条路径都不会读取其他浏览器标签、Cookie、MCP 配置或后台剪贴板；`state` 校验、token 提取和保存始终由 Host 完成。

**设备码结论：**百度 `GET /oauth/2.0/device/code` 实测返回 200，并能拿到 `device_code`；但公开演示应用没有可安全使用的非空 `client_secret`，用设备码换 token 会被百度按缺少必需参数拒绝。因此它是“**有正式 client 凭据时可自动轮询回写，但不是零注册方案**”。当前演示应用零注册路径实际可行的是上述插件自有 webview 回读；正式应用则可用已登记的回调或设备码流程。

## 当时实际发生的步骤

1. 从百度官方 MCP 文档的“个人用户（限时体验）→ 发起授权请求”进入百度 OAuth 页面。该示例授权请求使用现成的 `client_id`，请求形态是 `https://openapi.baidu.com/oauth/2.0/authorize?client_id=<官方体验应用ID>&redirect_uri=oob&response_type=token&scope=basic,netdisk`。我们没有创建应用或获得自己的 AppKey/SecretKey。
2. 我把授权页打开在 Codex 侧边浏览器。**用户本人**在百度页面登录并点击授权；我没有读取或输入账号密码。百度完成授权后，浏览器停在 `https://openapi.baidu.com/oauth/2.0/login_success#...&access_token=<已遮盖>&...`。这是百度成功页，不是 `127.0.0.1` 回调页。
3. `#` 之后的片段只在浏览器端可见，浏览器发 HTTP 请求时不会把它发送给网站服务器。为做单机验证，我先启动临时 Node 服务，仅监听 `127.0.0.1:18791`，准备接收 token。它的源码是工作区的 `work/baidu-mcp-test/capture-token.mjs`。
4. 浏览器自动化从**那一个已授权标签的 URL**中，在内存里提取 `access_token`，没有打印 token；随后主动导航到 `http://127.0.0.1:18791/callback#token=<已遮盖>`。这是测试程序主动做的浏览器内交接，**不是百度 OAuth 自动重定向到 localhost**。片段名从百度的 `access_token` 映射为临时接收页约定的 `token`。
5. 本机服务响应 `/callback` 页面。页面 JavaScript 用 `location.hash` 取 `token`，再向本机 `/capture` 发 POST。之所以需要页面 JavaScript，是因为第 3 步所述的 URL 片段不会进入服务端的 GET `/callback` 请求。
6. 本机 Node 服务校验收到的 token 字符格式，将其写入仅供测试的 `work/baidu-token.txt`，返回成功并停止监听；页面用 `history.replaceState` 清掉地址栏中的片段并显示“授权已接收”。我只检查了文件是否存在及字节数，没有把 token 内容打印到对话中。
7. 后续 Node 脚本从这个测试文件读取 token，连接 `https://mcp-pan.baidu.com/sse?access_token=<已遮盖>`，调用 MCP 上传 JSON；下载则带同一 token 调用百度文件元数据接口获取 `dlink`，随后下载文件、在本地读取解析。测试结束删除了网盘上的测试 JSON。这个体验授权只给了 access token；测试没有取得可自动刷新的 refresh token。

简图：

```text
官方体验授权链接 → 百度登录/授权（用户操作）
  → 百度 login_success#access_token=…（token 在浏览器片段中）
  → Codex 从已授权标签提取片段并主动打开 localhost/callback#token=…
  → localhost 页面 JS 读取片段，POST 给本机服务
  → 本机服务写临时测试文件并停止
  → 测试脚本读取 token → MCP 上传 / 开放 API 下载
```

## 为什么不能把测试脚本直接做成正式登录功能

- 官方体验 `client_id` 的密钥按百度文档仅供限时测试、可能变更，不可作为 `dsh-history-plugin` 的正式凭据。
- 此次 `redirect_uri=oob` 的结果停在百度成功页；临时交接依赖 Codex 能读取所控制浏览器标签的 URL。普通 DSH 插件不应假定自己能读取用户其他浏览器标签或抓取百度登录页。
- 当前 Desktop 插件只读取自己创建的 guest webview，不读取用户其他浏览器标签；bridge 协议不可用时才依赖一次显式复制，且不会后台扫描其他应用或浏览器页面。
- 测试脚本把 token 经本机请求参数传递并写成明文测试文件，只适合受控验证。发布版要用受支持的 OAuth 回调/设备码流程和 Host 安全凭据存储，避免 token 进入 URL 日志、浏览器历史、配置文件、Client 端或插件日志。
- 发布版的“自动复用登录”是读取**本插件此前保存**的授权并刷新，而不是扫描百度客户端或浏览器的登录凭证。
- 设备码流程能避免复制地址，但设备码换 token 仍需要应用方持有有效凭据；把需要保密的值硬塞进桌面插件不是安全的“零注册”方案。

## 设备码流程实测

探针 `_probe/baidu-device-code.mjs` 对当前公开演示应用做了以下验证：

1. `GET /oauth/2.0/device/code` 返回 200，响应包含 `device_code`、`verification_url`、`qrcode_url`、`expires_in` 和轮询间隔。
2. 用 `grant_type=device_token` 尝试换 token，无论参数名写 `code` 还是 `device_code`、无论完全不传 `client_secret` 还是传空值，都会被百度拒绝。
3. 拒绝原因表明缺少可用的客户端凭据，而不是“用户尚未授权”。演示应用没有可安全使用的 SecretKey，所以当前无法把它做成零注册设备码登录。

如果项目方有自己的百度开放平台应用，并确认它支持设备码授权且项目方有可信的换 token 方式，那么流程可以完全自动化：

```text
插件请求 device/code
  → 显示 verification_url 与 user_code（或二维码）
  → 用户任意设备浏览器授权
  → 插件按 interval 轮询 token 端点
  → 拿到 access_token / refresh_token
  → Host 保存并同步
```

这条路径不需要本机回调，也不需要用户复制 URL；代价是必须先有正式应用凭据。

## DSH 正式实现应采用的状态机

```text
未连接
  └─ 用户在 设置 → 历史插件 点击「连接百度网盘」
      └─ Host 创建一次性授权会话（state、超时、取消机制）
          ├─ DSH Desktop bridge v1：插件自有 guest webview 打开百度授权页
          │   ├─ 授权面板作为最上层模态显示（Escape 取消；加载失败/超时 → 回退剪贴板）
          │   └─ 百度 login_success URL → Client 只读该 webview URL
          │       → 连同 state 交给 Host → Host 提取并保存 token
          ├─ 非 Desktop / bridge 不可用：外部浏览器 + 显式复制一次
          │   └─ 窗口聚焦/恢复可见 → Client 读剪贴板 → Host 校验并保存
          └─ 正式自有应用：本机已登记回调或设备码轮询
              └─ Host 用正式凭据换 token（需要时由可信服务端完成）
                  └─ 查询百度用户 ID 验证账号
                      └─ 将 token、刷新信息保存在 Host 安全存储
                          └─ 清理一次性授权会话 → 自动同步
```

启动时先检查本插件安全存储：access token 有效则验证并同步；过期且有 refresh token 则刷新；两者都不可用才显示“连接百度网盘”。账号切换时隔离本地历史缓存。授权失败、取消或超时都不得留下“已连接”假状态。

**待 DSH 与百度确认的阻塞点：**正式百度网盘应用由谁登记、允许哪种桌面客户端 OAuth 方式、是否必须使用不能安全嵌入客户端的 SecretKey。如果只支持需要保密 SecretKey 的模式，单纯把 SecretKey 写进开源/桌面插件不构成安全方案；需另选获准的公共客户端流程或由应用方提供可信的换 token 服务。普通用户不应每人注册开发者应用。

## 参考

- [百度网盘 MCP 官方接入说明](https://github.com/baidu-netdisk/mcp/blob/main/README.md)：个人用户体验授权、正式接入限制与 MCP token 配置。
- [百度网盘官方 Go SDK](https://github.com/baidu-netdisk/baidu-drive-sdk-go)：授权码、设备码、刷新 token 的接口示例。
- 本机测试接收器位于当时的工作目录 `work/baidu-mcp-test/capture-token.mjs`，未随仓库发布；它仅供理解第 3–6 步，不可直接用于正式产品。
