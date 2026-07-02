# OLD_REMOTE_ENTRY 启动引导规范

> 目标：定义用户不更新客户端时，旧远程入口如何进入新远程 Web，并具备硬兜底。  
> 依据：`小尊宝2.0基础底座建设方案.md`、`analysis_unpack/app_asar/dist-electron/main/config.js`、`main/index.js`。

## 1. 入口事实

客户端固定加载 `OLD_REMOTE_ENTRY`，当前为 `https://apptool.zzbtool.com`。证据：

- `config.js:46`：`HomeIndexUrl = "https://apptool.zzbtool.com"`
- `index.js:106`：`mainWindow.loadURL(HomeIndexUrl)`

Phase 1 不发 Electron 包，因此必须重新建设或接管 `OLD_REMOTE_ENTRY`。

## 2. 启动目标

```text
Electron -> OLD_REMOTE_ENTRY -> entry config -> NEW_REMOTE_WEB_ORIGIN -> Liehu Shell / Legacy App Replica
```

`OLD_REMOTE_ENTRY` 是入口层，不再承载完整业务。

## 3. 入口 HTML 要求

- 首屏 HTML 足够小，避免入口加载失败。
- 内置硬兜底文案和重试按钮。
- 加载入口配置超时建议 1500-3000 ms。
- 配置不可用时进入 Legacy App Replica 或硬兜底。
- 不能依赖新主站 JS 才能回退。

## 4. 引导模式

| 模式 | 说明 | 适用 |
|---|---|---|
| HTTP redirect | 服务端 302 到 `NEW_REMOTE_WEB_ORIGIN` | 新主站稳定后 |
| HTML bootstrap | 旧入口 HTML 读取配置后 `location.replace` | 灰度期 |
| Remote loader | 旧入口加载新主站入口脚本 | 需要保留旧 origin 时 |
| Hard fallback | 配置/新主站不可用时显示兜底页 | 必须具备 |

## 5. 配置示例

```json
{
  "version": "2026.07.02.1",
  "enabled": true,
  "newRemoteOrigin": "NEW_REMOTE_WEB_ORIGIN_PROD",
  "mode": "redirect",
  "timeoutMs": 2500,
  "fallback": {
    "mode": "legacy-replica",
    "url": "/legacy/index.html"
  }
}
```

## 6. 验收

- 现有客户端无需更新即可进入新远程 Web。
- 入口配置关闭后不进入 Liehu Shell。
- 新主站 DNS/CDN/HTML 不可用时，旧入口仍能显示硬兜底。
- 入口配置和新主站资源都必须带版本号，便于定位。

