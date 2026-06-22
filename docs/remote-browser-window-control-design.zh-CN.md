# 远程浏览器窗口接管设计文档

## 1. 背景

Tianshe 当前已经具备 Browser Runtime、Profile、Browser Pool、MCP/HTTP 编排、账号登录弹窗等基础能力。现有远程浏览器控制主要围绕 tab/page 级自动化命令展开，例如 DOM、CDP、extension relay、Playwright/Cloak、Firefox BiDi 等路径。

新的需求是：软件运行在多台电脑上时，控制端可以远程查看并操控某台电脑上的浏览器窗口，尤其用于登录、验证码、2FA、浏览器扩展弹窗、钱包插件、地址栏、文件选择框等 tab 级自动化不容易覆盖的场景。

本文设计首版以 **浏览器窗口捕获 + WebRTC 传输 + OS 级输入** 为主线。

## 2. 目标

1. 支持控制端远程查看指定电脑上的指定浏览器窗口。
2. 支持鼠标、键盘、滚轮、拖拽、文本输入等基础远程操作。
3. 能操作浏览器工具栏、扩展 popup、浏览器原生 UI，以及网页内容。
4. 复用现有 Profile、Browser Pool、Account Login、runtime descriptor 和 session lease 体系。
5. 默认由远端客户端主动连接中心 broker，不对外暴露本机 HTTP/MCP 端口。
6. 首版优先支持 Windows，后续扩展 macOS/Linux。
7. 为后续 tabCapture、CDP screencast、SFU 多人观看保留扩展点。

## 3. 非目标

1. 首版不做完整远程桌面产品，不控制整个操作系统。
2. 首版不做多人同时控制同一窗口。
3. 首版不绕过验证码、2FA、风控或站点安全策略。
4. 首版不允许明文密码进入大模型上下文、日志、trace、失败包。
5. 首版不依赖直接暴露 Chrome DevTools remote debugging port。
6. 首版不承诺最小化窗口仍可稳定捕获。

## 4. 核心判断

### 4.1 为什么选择 window capture

tabCapture 和 CDP screencast 只能覆盖 tab 内容，无法覆盖 Chrome 工具栏、扩展 popup、地址栏、浏览器菜单、系统文件选择框。

window capture 捕获整个浏览器窗口，能覆盖：

- 网页内容
- 浏览器地址栏
- 扩展工具栏图标
- 扩展 popup
- 浏览器原生弹窗
- OAuth、钱包、验证码插件等窗口内 UI

因此 window capture 更适合人工接管登录和复杂验证场景。

### 4.2 window capture 的代价

window capture 的难点不在视频传输，而在：

- 捕获目标窗口的稳定识别
- DPI 和坐标映射
- OS 级输入注入
- 焦点管理
- 多显示器和窗口移动
- 最小化、隐藏、遮挡、权限和平台差异
- 安全审计和用户授权

## 5. 总体架构

```text
Control Console
  控制端 UI，显示设备、会话、浏览器窗口、远程画面

Broker / Signaling Server
  设备注册、鉴权、WebRTC 信令、会话路由、审计

Remote Node Agent
  运行在被控电脑的 Tianshe 客户端

WindowCaptureProvider
  枚举和捕获浏览器窗口，输出 MediaStream 或帧流

RemoteInputProvider
  将控制端输入事件注入到目标窗口

BrowserSessionBridge
  连接 Profile、Browser Pool、Account Login、Runtime 状态和远程接管会话
```

### 5.1 控制端

控制端可以是：

- Tianshe 桌面客户端中的远程控制页面
- Web 管理台
- 未来的云端控制台

核心职责：

- 列出设备和在线状态
- 列出待接管登录任务
- 打开远程窗口画面
- 发送鼠标和键盘输入
- 显示连接质量、权限、会话状态
- 支持结束接管、释放锁、标记登录完成

### 5.2 Broker

Broker 不直接控制浏览器，只做中转和治理：

- 设备注册与心跳
- 用户、组织、设备授权
- WebRTC offer/answer/ice 信令
- TURN 配置下发
- 会话锁和租约协调
- 审计日志
- 断线恢复和超时清理

首版可以只做 signaling，不做 SFU。单人远控使用 P2P + TURN relay 即可。

### 5.3 Remote Node Agent

Remote Node Agent 在被控电脑的 Tianshe 客户端内运行。

职责：

- 主动连接 Broker
- 注册设备能力和版本
- 获取本机 Browser Pool / Profile 状态
- 根据接管请求打开或前置目标浏览器窗口
- 捕获目标窗口并建立 WebRTC 连接
- 接收输入事件并注入到目标窗口
- 上报状态、错误和质量指标

## 6. 会话模型

### 6.1 RemoteControlSession

```ts
interface RemoteControlSession {
  id: string;
  deviceId: string;
  profileId?: string;
  browserId?: string;
  runtimeId?: string;
  accountId?: string;
  windowId?: string;
  captureSourceId?: string;
  mode: 'window';
  state:
    | 'requested'
    | 'preparing'
    | 'signaling'
    | 'streaming'
    | 'controlling'
    | 'reconnecting'
    | 'paused'
    | 'ending'
    | 'ended'
    | 'failed';
  controllerUserId: string;
  leaseToken: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
```

### 6.2 状态机

```text
requested
  -> preparing
  -> signaling
  -> streaming
  -> controlling
  -> ending
  -> ended

streaming / controlling
  -> reconnecting
  -> streaming / failed

任何状态
  -> failed
```

### 6.3 锁模型

同一个 profile/browser/window 同时只允许一个 active controller。

需要新增或扩展现有资源租约：

```text
profile-live-session lease
browser remote-control lease
window remote-control lease
```

接管期间：

- 自动化任务应暂停或进入等待
- 其他远程控制请求排队或失败
- 会话超时后自动释放

## 7. 捕获设计

### 7.1 首版捕获路径

Windows 首版优先使用 Electron `desktopCapturer` 获取浏览器窗口源：

```text
desktopCapturer.getSources({ types: ['window'] })
  -> 选择目标浏览器窗口 sourceId
  -> navigator.mediaDevices.getUserMedia(...)
  -> MediaStream
  -> RTCPeerConnection.addTrack(...)
```

实现位置建议：

```text
src/main/remote-control/
  session-manager.ts
  signaling-client.ts
  window-source-resolver.ts
  input-controller.ts

src/renderer/src/remote-control/
  RemoteControlPage.tsx
  remoteControlClient.ts

src/preload/api/
  remote-control.ts
```

由于 WebRTC 和 MediaStream 更适合在 renderer 中处理，建议主进程负责权限、窗口识别和 IPC，renderer 负责 RTCPeerConnection 和 MediaStream。

### 7.2 捕获源选择

首版支持两种模式：

```text
auto:
  根据 browserId/runtimeId 尝试匹配窗口标题、进程、bounds

manual:
  控制端或被控端展示窗口列表，由用户选择目标窗口
```

MVP 可以先做 manual，再逐步做 auto。

### 7.3 浏览器窗口匹配策略

不同 runtime 的窗口来源不同：

| Runtime | 窗口识别策略 |
| --- | --- |
| electron-webcontents | 捕获 Tianshe popup/main window 或 BrowserView 所在窗口 |
| chromium-extension-relay | 捕获外部 Chromium/Chrome 窗口 |
| chromium-cloak-playwright | 捕获 Cloak/Chromium 外部窗口 |
| firefox-bidi | 捕获 Firefox 外部窗口 |

匹配信号：

- window title
- process name
- process id
- bounds
- runtimeId
- browserId
- recently shown window
- URL/title from BrowserInterface

若自动匹配不确定，必须回退人工选择。

### 7.4 最小化和隐藏窗口

首版要求：

- 目标窗口不可最小化
- 若最小化，接管开始前调用 browser.show 或 window restore
- 若窗口被关闭，远控会话失败并释放锁

后续可研究 Windows Graphics Capture 的 native window capture，以提高隐藏/遮挡情况下的稳定性。

## 8. 输入设计

### 8.1 输入路径

```text
控制端 UI
  -> pointer/key/wheel/text event
  -> WebRTC DataChannel
  -> Remote Node Agent
  -> RemoteInputProvider
  -> OS input
  -> 目标浏览器窗口
```

### 8.2 输入事件协议

```ts
type RemoteInputMessage =
  | {
      type: 'pointer';
      action: 'move' | 'down' | 'up' | 'click' | 'doubleClick';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      modifiers?: string[];
      timestamp: number;
    }
  | {
      type: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      timestamp: number;
    }
  | {
      type: 'key';
      action: 'down' | 'up' | 'press';
      key: string;
      code?: string;
      modifiers?: string[];
      timestamp: number;
    }
  | {
      type: 'text';
      text: string;
      timestamp: number;
    }
  | {
      type: 'clipboard';
      action: 'setText' | 'paste';
      text?: string;
      timestamp: number;
    };
```

### 8.3 坐标映射

控制端点击的是视频元素坐标，必须映射到被控端窗口屏幕坐标：

```text
viewer client point
  -> video content point
  -> stream pixel point
  -> captured window logical point
  -> target window screen point
  -> OS input
```

需要记录：

- 视频元素尺寸
- object-fit/crop/letterbox
- stream 实际宽高
- 被控端窗口 bounds
- DPI scale
- 多显示器 offset

### 8.4 文本输入

普通键盘事件适合快捷键和简单字符。

中文、长文本、密码、特殊字符建议走 `text` 消息，由远端执行：

- Windows：剪贴板 paste 或 SendInput unicode
- 浏览器 tab 内容：可选 CDP `Input.insertText`
- 密码：不得进入日志和模型上下文

## 9. 信令协议

Broker WebSocket 消息示例：

```ts
type SignalMessage =
  | {
      type: 'device.register';
      deviceId: string;
      version: string;
      capabilities: string[];
    }
  | {
      type: 'remoteControl.request';
      sessionId: string;
      deviceId: string;
      profileId?: string;
      browserId?: string;
      reason: 'manual_login' | 'captcha' | 'two_factor' | 'operator_request';
    }
  | {
      type: 'remoteControl.offer';
      sessionId: string;
      sdp: string;
    }
  | {
      type: 'remoteControl.answer';
      sessionId: string;
      sdp: string;
    }
  | {
      type: 'remoteControl.ice';
      sessionId: string;
      candidate: unknown;
    }
  | {
      type: 'remoteControl.end';
      sessionId: string;
      reason: string;
    };
```

DataChannel 用于实时输入和质量指标，不建议通过 Broker 转发输入，除非 WebRTC DataChannel 失败。

## 10. 和现有框架集成

### 10.1 Browser Pool

新增 AcquireSource：

```ts
type AcquireSource = 'http' | 'mcp' | 'ipc' | 'internal' | 'plugin' | 'remote-control';
```

远程接管开始时：

1. resolve profile/account/browser
2. acquire profile live-session lease
3. acquire browser handle 或复用现有 live browser
4. show/restore browser window
5. start window capture
6. 建立 WebRTC

远程接管结束时：

1. stop capture
2. close peer connection
3. release remote-control lease
4. 根据策略 release browser handle 或保留 idle

### 10.2 账号登录

当前 `account:login` 已具备打开账号登录窗口的基础能力。远程接管可以复用其语义：

```text
profile.ensure_logged_in(site, profileId)
  -> needs_manual_login
  -> account/login window shown
  -> remoteControl.request
  -> operator controls window
  -> operator marks completed
  -> verify login state
  -> resume automation
```

### 10.3 Runtime descriptor

为 runtime 增加能力描述：

```ts
type RemoteControlCapability = {
  windowCapture: 'supported' | 'fallback' | 'unsupported';
  osInput: 'supported' | 'unsupported';
  tabCapture?: 'supported' | 'unsupported';
  cdpScreencast?: 'supported' | 'unsupported';
};
```

## 11. 安全设计

### 11.1 鉴权

必须具备：

- 设备 token
- 用户 token
- 组织/团队权限
- session lease token
- 短时有效远控授权

远控会话必须绑定：

- deviceId
- userId
- profileId/browserId/windowId
- reason
- start/end time

### 11.2 用户授权

建议策略：

- 默认需要被控端已登录并受信任
- 远控开始时在被控端显示显著提示
- 支持本机一键断开
- 高风险 profile 可要求本机确认

### 11.3 数据最小化

不得记录：

- 视频帧
- 密码明文
- cookies/token
- 剪贴板敏感内容

可以记录：

- 会话开始/结束
- 控制者
- 被控设备
- profile/browser/window
- 输入事件统计，不记录具体文本
- 质量指标

### 11.4 密码和密钥

密码输入有两种安全路径：

1. 人直接在远控窗口中输入，系统不记录。
2. 通过本地 safeStorage/secretRef 注入，模型和 broker 不接触明文。

禁止：

- 明文密码进入 LLM prompt
- 明文密码进入 WebRTC DataChannel 日志
- 明文密码进入 trace/failure bundle

## 12. 观测和诊断

每个远控会话记录：

- sessionId
- deviceId
- profileId
- browserId
- runtimeId
- captureSourceId
- WebRTC state
- ICE state
- RTT
- bitrate
- packet loss
- frame width/height
- frame rate
- input latency estimate
- reconnect count
- end reason

常见错误码：

```text
remote_control_device_offline
remote_control_permission_denied
remote_control_lease_conflict
remote_control_capture_source_not_found
remote_control_window_minimized
remote_control_signaling_failed
remote_control_webrtc_failed
remote_control_turn_required
remote_control_input_injection_failed
remote_control_target_window_closed
```

## 13. MVP 范围

### 13.1 MVP 必做

- Windows
- 控制端页面
- 设备主动连接 broker
- WebRTC P2P + TURN 配置
- 手动选择浏览器窗口
- 窗口画面捕获
- 鼠标点击/移动/滚轮
- 键盘按键/文本输入
- 单控制者锁
- 会话开始/结束审计
- 断线后释放锁

### 13.2 MVP 可不做

- macOS/Linux
- 自动窗口识别
- 多人观看
- 录制
- 隐私遮罩
- 文件传输
- 远程剪贴板双向同步
- SFU
- tabCapture/CDP screencast 优化

## 14. 分阶段计划

### Phase 1：可视连接

- Broker signaling
- Remote Node 注册
- 控制端打开 session
- 被控端选择 window source
- 建立 WebRTC 视频流
- 显示远程浏览器窗口

验收：

- 控制端能看到指定浏览器窗口
- 断开后资源释放
- TURN relay 下可连通

### Phase 2：基础控制

- DataChannel 输入
- 坐标映射
- Windows OS 级鼠标键盘输入
- 焦点管理
- 远控开始时前置目标窗口

验收：

- 能点击网页按钮
- 能输入账号密码
- 能滚动页面
- 能打开和操作扩展 popup

### Phase 3：框架集成

- 接入 Account Login
- 接入 Profile live-session lease
- 接入 Browser Pool
- 添加 remote-control source
- 添加远程登录接管队列

验收：

- AI 任务遇到登录后暂停
- 控制端接管登录
- 登录完成后任务恢复

### Phase 4：稳定性和安全

- 自动窗口识别
- 会话审计
- 权限策略
- reconnect
- capture/input 错误恢复
- 敏感输入保护

验收：

- 多设备并发稳定
- 锁冲突可诊断
- 权限拒绝清晰
- 日志不泄露敏感信息

## 15. 测试策略

### 15.1 单元测试

- 坐标映射
- session 状态机
- lease 冲突
- signaling 消息校验
- 权限判断
- 错误码映射

### 15.2 集成测试

- mock Broker + mock PeerConnection
- Remote Node 注册和心跳
- session start/end
- capture source 选择
- input event 分发

### 15.3 手工验收

Windows 环境：

- Chrome/Chromium 外部窗口
- Electron WebContents popup
- 浏览器扩展 popup
- 多显示器
- 125% / 150% DPI
- 浏览器窗口移动/resize
- TURN relay 网络
- 断网重连

### 15.4 安全验收

- 密码不进入日志
- DataChannel 文本输入不落盘
- 未授权用户无法接管
- 被控端可断开
- 会话超时自动释放

## 16. 风险和缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 窗口匹配错误 | 捕获错误窗口 | MVP 先人工选择，后续多信号匹配 |
| DPI 坐标偏移 | 点击错位 | 坐标映射单测，多 DPI 手工验收 |
| 最小化窗口黑屏 | 无法接管 | 接管前 restore/show，失败给明确错误 |
| OS 输入被系统拦截 | 无法点击 | 前置窗口、权限检测、降级提示 |
| TURN 不可用 | 跨网失败 | 连接前 health check，失败展示诊断 |
| 密码泄露 | 高风险 | 不记录文本输入，secretRef，本地注入 |
| 多控制者冲突 | 状态错乱 | 单控制者 lease |
| 其他远控/安全软件冲突 | 输入失败 | 检测并给出可诊断错误 |

## 17. 推荐首版技术选型

```text
视频捕获：
  Electron desktopCapturer + renderer getUserMedia

视频传输：
  WebRTC P2P + TURN

信令：
  Broker WebSocket

输入：
  WebRTC DataChannel + Windows OS input

设备连接：
  Remote Node 主动连接 Broker

权限：
  device token + user token + short-lived session lease
```

## 18. 后续扩展

1. tabCapture：优化 chromium-extension-relay 的 tab 级流畅度。
2. CDP screencast：作为 Chromium/Playwright tab 模式 fallback。
3. Windows Graphics Capture：提升窗口捕获质量和稳定性。
4. SFU：支持多人观看、录制、旁路审计。
5. Remote clipboard：受控、可审计的剪贴板同步。
6. Privacy mode：被控端遮罩或提示正在远控。
7. Per-site login health：接入 `profile.ensure_logged_in`。

## 19. 结论

window capture 是解决“远程人工接管浏览器”的更完整方案。它比 tabCapture/CDP screencast 覆盖面更大，能处理扩展 popup、浏览器工具栏、地址栏和复杂登录验证。

首版建议聚焦 Windows、单控制者、手动窗口选择、WebRTC P2P、OS 级输入。这样能最快验证核心价值，并且和现有 Browser Pool、Profile、Account Login 体系自然衔接。

