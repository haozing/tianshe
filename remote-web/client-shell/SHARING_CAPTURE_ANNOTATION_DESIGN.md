# 赤狐管家页面缩放功能设计

状态：已实现，自动化验证通过
日期：2026-07-23  
适用范围：`remote-web/client-shell` 与 `electron-client`

## 1. 目标

在设置页面提供主窗口页面大小选项：

- 标准：`100%`
- 中：`110%`
- 大：`125%`

用户点击档位后立即作用于整个赤狐管家主窗口，并立即保存。应用重启、主页面刷新或远程版本切换后，继续使用上次保存的比例。

本功能是普通页面显示设置，不属于分享、截图、标注或隐私功能。

## 2. 范围与边界

- 缩放范围是赤狐管家主窗口的 `WebContents`，包括 Logo、主菜单、二级菜单、窗口控制、设置弹窗和业务内容。
- 不缩放抖店等平台子窗口，不允许 renderer 指定其他窗口或传入 `winId`。
- 不修改窗口物理尺寸。
- 不使用 CSS `zoom`，不在业务页面增加局部缩放容器。
- 不新增分享总开关，不处理店名隐藏、水印、截图或画板。
- 旧版 Electron 没有缩放桥时，页面大小控件禁用并显示升级提示。

## 3. 现有代码边界

主窗口壳层位于 `src/App.tsx`，固定包含 `84px` 的 `ShellHeader` 和路由内容区。设置弹窗位于 `src/components/ShellHeader.tsx`，偏好统一通过 `src/bridge/storage.ts` 保存到 `chihu20_preferences`。

Electron 当前已经有：

- 主窗口创建和远程页面加载：`electron-client/src/main/index.js`
- preload 白名单：`electron-client/src/preload/index.js`
- main/runner 权限守卫：`electron-client/src/main/license/ipc-guard.js`
- 主窗口专属通道清单：`electron-client/src/main/license/window-control-policy.js`

## 4. 状态与持久化

### 4.1 类型

```ts
export type PageScale = 1 | 1.1 | 1.25;

interface ChihuPreferences {
  // existing fields...
  pageScale: PageScale;
}
```

默认值为 `1`。`normalizePreferences` 对缺失、字符串、任意小数、`NaN`、无穷值和其他非法值统一回退为 `1`。

### 4.2 保存时机

页面大小档位点击后：

```text
点击档位
  -> 调用主窗口缩放 IPC
  -> 原生调用成功：保存 pageScale 并广播偏好变更
  -> 原生调用失败：不保存失败值，控件恢复最后保存的比例并显示错误
```

页面大小和现有操作日志偏好共用 `savePreferences`，不新增 localStorage key。由于偏好保存在持久分区，应用重启后可以恢复。

## 5. 设置页面

设置弹窗顶部增加“页面显示”分区，现有“内测体验”和“异常排查”保持不变：

```text
页面显示

页面大小       [标准 100%] [中 110%] [大 125%]
```

控件使用分段按钮：

- 当前保存比例为选中状态。
- 点击后立即执行，不等待“确认”按钮。
- 原生桥不可用时全部禁用。
- 成功后保留选中状态并写入 `pageScale`。
- 失败后回到保存值，不把失败值写入偏好。

设置底部现有“确认”按钮仍只提交其他需要确认的设置，不负责页面大小的提交或回滚。

## 6. 原生接口

### 6.1 Renderer 类型

```ts
interface NativeWindowApi {
  setMainZoom?: (args: {
    factor: 1 | 1.1 | 1.25;
  }) => Promise<{
    ok: boolean;
    factor: 1 | 1.1 | 1.25;
    message?: string;
  }>;
}
```

兼容旧客户端时，renderer 通过 `typeof window.chihuNative?.windows.setMainZoom === "function"` 判断能力是否存在。

### 6.2 IPC 通道

```text
setMainZoom
```

Preload 只暴露 `client.setMainZoom` 和 `chihuNative.windows.setMainZoom` 两个固定白名单入口，不暴露通用 `setZoomFactor`，不接收 `winId`。

### 6.3 主进程约束

handler 必须同时满足：

- 参数必须是数值 `1`、`1.1` 或 `1.25`。
- 拒绝字符串、`NaN`、无穷值和任意其他比例。
- 通过现有 principal guard，只允许 `main` 角色。
- 再验证 `event.sender === getMainWindow().webContents`。
- 使用 `event.sender.setZoomFactor(factor)`，只作用于调用者自身。
- runner、平台子窗口和非当前主窗口返回可识别错误。
- 通道加入 `MAIN_WINDOW_ONLY_CHANNELS`。

## 7. 生命周期

### 7.1 新建和导航

- 新建主窗口默认原生比例为 `1`。
- 非 hash 的主框架导航、页面刷新和远程版本切换开始时，主进程先复位为 `1`。
- 新页面启动后读取持久化 `preferences.pageScale`，调用 `setMainZoom` 恢复保存比例。
- hash 路由切换不复位，当前比例继续生效。

### 7.2 重启恢复

应用重启后：

```text
renderer 启动
  -> initStorage / getPreferences
  -> 读取 pageScale
  -> 检测 setMainZoom
  -> 应用保存比例
```

如果保存值损坏，归一化为 `1` 并覆盖回本地偏好。

### 7.3 并发与失败

页面大小按钮在一次调用未完成时禁用，避免连续点击造成状态错乱。IPC 拒绝、窗口销毁或 native 调用异常时：

- 不写入新值。
- UI 保留最后保存的比例。
- 显示轻量错误，不阻塞其他设置。

## 8. 必须修改的文件

- `remote-web/client-shell/src/bridge/storage.ts`：增加 `PageScale`、偏好字段、默认值和归一化。
- `remote-web/client-shell/src/components/ShellHeader.tsx`：增加页面显示分区和即时保存逻辑。
- `remote-web/client-shell/src/bridge/pageScale.ts`：串联原生应用、偏好保存和失败回滚。
- `remote-web/client-shell/src/native/types.ts`：增加缩放结果和可选窗口接口。
- `remote-web/client-shell/src/bridge/client.ts`：增加缩放能力检测和调用封装。
- `electron-client/src/main/index.js`：注册 handler、sender 校验和导航复位。
- `electron-client/src/main/window/main-zoom-policy.js`：集中校验主窗口、比例和原生调用结果。
- `electron-client/src/main/license/window-control-policy.js`：登记 main-only 通道。
- `electron-client/src/preload/index.js`：暴露白名单方法。
- `electron-client/scripts/client-contract-baseline.js`：登记契约。
- `electron-client/test/freemium-task-registry.test.js`：验证 runner 被拒绝。
- `remote-web/new-remote-web/`：构建后的实际远程包。

## 9. 测试方案

### 9.1 client-shell

- 旧偏好缺少 `pageScale` 时归一化为 `1`。
- 合法值只有 `1`、`1.1`、`1.25`。
- 非法值不会写入偏好。
- 点击页面大小后成功调用 native 并保存。
- native 失败不保存失败值。
- native 桥不存在时控件禁用。
- 设置其他字段不会覆盖已保存的 `pageScale`。

### 9.2 Electron

- 当前主窗口可以调用三档缩放。
- runner 调用返回 `IPC_ROLE_DENIED`。
- 非当前主窗口即使拥有异常 main principal 也不能调用。
- 字符串比例、任意小数、`NaN` 和无穷值均被拒绝。
- hash 路由不复位，刷新和远程版本切换后重新应用保存比例。

### 9.3 视觉验收

至少覆盖：

- `1480x920` 和 `1920x1080` 窗口下的三档比例。
- Windows 150% DPI 且显示器能容纳当前最小窗口的环境。
- Logo、菜单、窗口控制、设置弹窗和业务内容比例一致。
- 无明显文字重叠、菜单遮挡、弹窗越界或滚动失效。

## 10. 验收标准

1. 设置页面存在默认 `100%` 的页面大小分段控件。
2. 点击档位后主窗口立即缩放并保存。
3. 应用重启、刷新和远程版本切换后恢复保存比例。
4. 页面缩放覆盖整个主窗口，不改变窗口物理尺寸。
5. 非法比例、runner、其他窗口和旧版客户端均安全拒绝或降级。
6. 既有操作日志、版本渠道和业务功能不受影响。
7. 构建后的 `/new-remote-web/` 包含该功能，并通过 Electron contract、release gate 和真实 UI 验收。
