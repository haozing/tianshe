# 赤狐管家分享、截图与画板功能设计

状态：设计稿，待评审后实施  
日期：2026-07-23  
适用范围：`remote-web/client-shell` 与 `electron-client`

## 1. 背景与目标

本功能用于直播、演示和日常分享。用户可以在设置中开启店名隐藏、内容区水印和内容缩放，并在主窗口顶部直接截图或进入画板模式进行标注。

本期目标：

1. 所有由赤狐管家控制的可见界面统一支持店名脱敏。
2. 水印只覆盖菜单头下方的内容区域，不覆盖主菜单和二级菜单。
3. 内容大小支持小、标准、大三档，视觉效果接近浏览器缩放，但不改变菜单头和窗口控制区。
4. 主菜单右侧增加截图和画板两个图标按钮。
5. 画板只允许在内容区域书写；开启时，二级菜单行右侧显示颜色、粗细和清除工具。
6. 截图包含主菜单、二级菜单和内容区域；画板开启或关闭时都能截图；已有笔迹和水印必须进入截图。
7. 截图操作适合直播场景，点击后快速完成，不弹出会遮挡直播画面的复杂流程。

## 2. 非目标与边界

- 第一版只截取主窗口当前可见区域，不做长截图和滚动拼接。
- 不截取单独打开的抖店后台子窗口，也不把多个原生窗口合成一张图。
- 店名隐藏只改变显示值，不修改接口参数、数据库、店铺匹配、筛选、导入导出和任务执行使用的原始店名。
- 赤狐管家可以隐藏店铺子窗口的原生标题，但不会注入或篡改第三方抖店页面中的店名。第三方页面内容不属于本应用可控的显示层。
- 第一版不保存笔迹工程文件，不支持撤销、橡皮擦局部擦除和跨路由恢复。

## 3. 现有代码结构结论

### 3.1 页面边界

`remote-web/client-shell/src/App.tsx` 当前将主窗口划分为固定的 `84px` 菜单头和剩余内容区：

```text
主窗口
├── ShellHeader（84px）
│   ├── 主菜单行（46px）
│   └── 二级菜单行（38px）
└── 内容区（剩余高度）
    └── 当前路由页面
```

因此，水印和画板应挂在 `App.tsx` 的内容区壳层，截图范围则是整个主窗口渲染区域。不能把水印和画板分别接入每个业务页面。

### 3.2 顶部工具位置

`remote-web/client-shell/src/components/ShellHeader.tsx` 的主菜单右侧已经包含账号、续费和窗口控制按钮。截图、画板按钮应放在该工具组最前面，和用户标注位置一致。

画板模式的颜色、粗细和清除工具放在二级菜单行右侧。二级导航继续占据可滚动区域，画板工具保持固定宽度，不随二级菜单横向滚动。

### 3.3 设置与持久化

设置弹窗当前位于 `ShellHeader.tsx`，偏好通过 `remote-web/client-shell/src/bridge/storage.ts` 中的 `ChihuPreferences`、`savePreferences` 和偏好变更事件保存到本地。

分享设置应沿用这一机制，不创建第二套设置存储。老版本没有新增字段时，由 `normalizePreferences` 自动补默认值，保证升级兼容。

### 3.4 原生能力

Electron 主进程已经存在窗口 IPC、preload 桥接和 main/runner 权限隔离，但没有主窗口截图接口。新能力必须接入现有权限守卫，且只允许主页面调用，任务 runner 不得调用。

### 3.5 店名显示现状

当前至少 15 个页面组件直接展示 `shopName`，任务进度消息、弹窗、提示信息和店铺子窗口标题也可能包含店名。不能使用 CSS 隐藏，也不能只在截图瞬间替换 DOM；这两种方案都会漏掉提示、`title` 属性、日志字符串和子窗口标题。

## 4. 总体设计

在应用壳层增加统一的 `ShareWorkspace`，负责偏好、内容缩放、水印、画板和截图状态；业务页面只消费统一的店名显示函数。

```text
ShareProvider
└── ShareCaptureRoot（现有 main，整个可截图区域）
    ├── ShellHeader
    │   ├── ScreenshotButton
    │   ├── DrawingToggleButton
    │   └── DrawingToolbar（仅画板模式显示）
    └── ShareContentSurface（仅内容区域）
        ├── ContentZoomViewport
        │   └── 当前路由页面
        ├── WatermarkLayer
        └── AnnotationCanvas
```

说明：`ShareCaptureRoot` 直接复用现有 `<main>`，不增加重复的页面容器。

建议新增文件：

- `remote-web/client-shell/src/sharing/ShareContext.tsx`
- `remote-web/client-shell/src/sharing/ShareContentSurface.tsx`
- `remote-web/client-shell/src/sharing/WatermarkLayer.tsx`
- `remote-web/client-shell/src/sharing/AnnotationCanvas.tsx`
- `remote-web/client-shell/src/sharing/storeNamePrivacy.ts`
- `remote-web/client-shell/src/sharing/types.ts`
- `electron-client/src/main/ipc/sharing.js`

## 5. 设置页面设计

在设置弹窗最上方增加“分享设置”分区，顺序为：店名隐藏、水印、内容大小。现有“内测体验”和“异常排查”保持不变。

```text
分享设置

隐藏店名       [开关]
页面水印       [开关] [水印文字输入框]
内容大小       [小 90%] [标准 100%] [大 110%]
```

交互规则：

- “隐藏店名”默认关闭，切换后立即影响所有已接入的显示面。
- “页面水印”默认关闭。关闭时输入框保留上次文字但不可编辑；开启时若文字为空，输入框显示校验错误，不能确认设置。
- 水印文字去除首尾空白和控制字符，最多 32 个字素，不允许 HTML；使用普通 React 文本节点渲染。
- “内容大小”默认 `100%`，使用三段式选择控件，切换后立即预览。
- 点击“确认”统一保存当前分享设置；关闭或取消时恢复打开设置前的值。现有立即保存的版本渠道切换逻辑保持独立。

偏好字段建议保持现有扁平结构：

```ts
interface ChihuPreferences {
  // existing fields...
  shareMaskStoreNames: boolean;
  shareWatermarkEnabled: boolean;
  shareWatermarkText: string;
  contentScale: 0.9 | 1 | 1.1;
}
```

默认值：

```ts
{
  shareMaskStoreNames: false,
  shareWatermarkEnabled: false,
  shareWatermarkText: "",
  contentScale: 1
}
```

## 6. 店名隐藏设计

### 6.1 脱敏规则

按 Unicode 字素而不是 JavaScript UTF-16 下标切分，避免 emoji、生僻字或组合字符被截断。优先使用 `Intl.Segmenter("zh-CN", { granularity: "grapheme" })`，不可用时回退到 `Array.from`。

| 原始长度 | 显示规则 | 示例 |
| --- | --- | --- |
| 5 个字及以上 | 保留前 2、后 2，中间固定为 `***` | `康鸟喜专卖店` -> `康鸟***卖店` |
| 3-4 个字 | 保留首尾各 1，中间为 `***` | `测试店铺` -> `测***铺` |
| 2 个字 | 保留首字，末字隐藏 | `店铺` -> `店*` |
| 1 个字 | 完全隐藏 | `店` -> `*` |
| 空值 | 沿用原有空值占位 | `-` |

短店名无法同时做到“保留前后两个字”和“隐藏中间文字”，上述规则优先保证隐私，不直接暴露完整短店名。

### 6.2 数据与显示分离

新增纯函数：

```ts
maskStoreName(rawName: string): string
displayStoreName(rawName: string, masked: boolean): string
```

同时提供统一组件处理文本和原生提示属性：

```tsx
<StoreNameText value={row.shopName} className="truncate" />
```

组件必须同步处理正文、`title` 和 `aria-label`，不能出现正文已脱敏但鼠标悬停仍暴露原店名的情况。

迁移范围：

- 店铺管理、经营数据、资金数据、违规数据。
- 商机收藏、商机预匹配、商机提报及动态提报日志。
- 商品清理和营销活动页面。
- 弹窗、确认文案、通知、Toast、运行进度和错误上下文中的店名。
- 赤狐管家创建的店铺子窗口标题。

不迁移范围：

- API 请求、任务参数、数据库记录和店铺匹配逻辑。
- CSV/Excel 等业务导出中的原始店名。后续如需分享型导出，应增加独立的“脱敏导出”选项。
- 第三方抖店页面自己渲染的店名。

### 6.3 防止漏改

第一轮迁移后增加静态审计脚本，扫描页面组件中直接渲染的 `shopName`/`store.name`。脚本不必禁止业务层使用原值，但应阻止新增未经过 `StoreNameText` 或 `displayStoreName` 的可见输出。

## 7. 水印设计

水印挂在 `ShareContentSurface` 内，只覆盖菜单头下方的内容区：

```text
内容区顶部 y = ShellHeader 实际高度
内容区底部 y = 主窗口可视区域底部
```

渲染规则：

- 使用重复的文本水印单元，倾斜约 `-22deg`。
- 单元间距约 `220px x 120px`，透明度建议 `0.09`，文字颜色根据浅色页面使用中性深灰。
- `pointer-events: none`，不影响页面操作。
- 水印层高于业务内容、低于画板和模态弹窗。
- 水印文本为空时不渲染，即使异常状态下偏好被写成“开启”。
- 水印随截图进入 PNG，不在截图后期合成，保证用户看到的内容和导出一致。

建议层级：

```text
z=0   业务页面
z=20  水印
z=30  画板 Canvas
z=40+ 业务弹窗/应用弹窗
z=45  ShellHeader（现有）
```

## 8. 内容大小设计

### 8.1 结论

采用应用页面层缩放，不采用 Electron/Chromium 的 `webContents.setZoomFactor`。

原因：

- 浏览器内核缩放会同时放大主菜单、二级菜单、窗口按钮和弹窗，违反“内容页面”边界。
- 内核缩放会改变整个 WebContents 的坐标系，增加 Canvas 指针坐标、截图尺寸和 DPI 换算的复杂度。
- 当前页面大量使用 Tailwind 固定像素字号，单纯修改父节点 `font-size` 无法完整生效。
- Electron 是固定 Chromium 环境，可以在内容路由容器使用 CSS `zoom`，效果最接近浏览器缩放，同时把影响限定在内容区。

### 8.2 实现方式

在当前路由页面外增加 `ContentZoomViewport`：

```tsx
<div className="content-zoom-viewport" style={{ zoom: preferences.contentScale }}>
  <ActiveComponent />
</div>
```

规则：

- 只缩放路由内容，不缩放 `ShellHeader`、水印和画板工具。
- 放大后允许内容区按原有规则出现滚动条，不通过压缩宽度强行塞回窗口。
- 水印保持固定视觉密度；画板按照缩放后的实际 `DOMRect` 接收坐标。
- 修改缩放档位、切换路由或主窗口尺寸变化时清空现有笔迹，避免笔迹与重新排版后的元素错位，并给出轻量提示。

## 9. 顶部截图与画板工具

### 9.1 主菜单按钮

在账号信息左侧增加两个 `28px x 28px` 图标按钮：

- 截图：使用 Lucide `Camera` 图标，提示“截图”。截图处理中禁用并显示加载状态。
- 画板：使用 Lucide `PenLine` 图标，提示“画板”。开启时使用品牌橙红色选中态，再次点击退出画板模式。

按钮使用 tooltip、`aria-label` 和明显焦点样式，不显示冗长的常驻说明文字。

### 9.2 二级菜单画板工具

画板开启时，二级菜单行右侧出现：

```text
[黑] [荧光绿] [荧光红]  [细] [中] [粗]  [清除]
```

实际 UI 使用色块和线宽圆点/线段表达，不使用大块文字按钮：

- 颜色：`#111827`、`#39FF14`、`#FF3131`。
- 粗细：`3px`、`6px`、`10px`，代表细、中、粗。
- 清除：使用 `Eraser` 或 `Trash2` 小图标；点击后一次清除所有笔迹。
- 所有选项有 tooltip 和 `aria-label`。
- 当窗口宽度不足时，二级导航可横向滚动，画板工具不换行；极窄宽度下将颜色和粗细收进一个小型 Popover，但清除按钮保留。

### 9.3 模式行为

- 开启画板后，内容区 Canvas 接管鼠标/触控输入，页面本身暂时不能点击和滚动。
- 菜单头仍可操作，因此用户可以切换颜色、粗细、截图或关闭画板。
- 鼠标进入内容区时显示画笔/十字光标，离开内容区恢复普通光标。
- 再次点击画板按钮或按 `Esc` 只退出书写模式，已有笔迹继续显示，便于退出后截图。
- 清除按钮负责删除笔迹；退出模式不等于清除。
- 切换路由、改变内容缩放或窗口尺寸时退出画板并清空笔迹，防止旧坐标覆盖到错误内容。
- 截图过程中临时禁止继续写入，结束后恢复原模式。

## 10. 画板技术设计

### 10.1 状态模型

画板状态属于当前窗口会话，不写入 `localStorage`：

```ts
type DrawingColor = "#111827" | "#39FF14" | "#FF3131";
type DrawingWidth = 3 | 6 | 10;

interface DrawingPoint {
  x: number;
  y: number;
  t: number;
}

interface DrawingStroke {
  color: DrawingColor;
  width: DrawingWidth;
  points: DrawingPoint[];
}

interface DrawingState {
  enabled: boolean;
  color: DrawingColor;
  width: DrawingWidth;
  strokes: DrawingStroke[];
}
```

颜色和粗细可以记住当前窗口的上次选择；笔迹不跨页面、不跨重启保存。

### 10.2 Canvas 渲染

- Canvas 绝对定位覆盖整个内容区，不覆盖菜单头。
- CSS 尺寸使用内容区的可见宽高，内部像素尺寸乘以 `window.devicePixelRatio`，保证高 DPI 截图不模糊。
- 使用 Pointer Events 和 `setPointerCapture`，兼容鼠标和触控笔。
- 优先读取 `getCoalescedEvents()`，对高频点做二次贝塞尔平滑。
- 笔触使用 `lineCap = "round"` 和 `lineJoin = "round"`。
- 每次完成一笔后保存向量点；Canvas 重绘时从笔画数组恢复，而不是只依赖像素缓存。
- `touch-action: none`，画板模式下阻止内容区域的滚动和选择文本。

## 11. 截图设计

### 11.1 技术选择

使用 Electron `BrowserWindow.webContents.capturePage()`，不引入 `html2canvas`。

原生截图的优势：

- 截取 Chromium 最终渲染结果，Canvas 笔迹、水印、字体、阴影和图片与屏幕一致。
- 不需要重新解析 DOM，不存在跨域图片污染 Canvas 的问题。
- 当前目标就是整个主窗口的 WebContents 可见区域，无需 DOM 长截图能力。
- 不包含 Windows 原生窗口边框，但包含赤狐管家自己的菜单头和内容区，正好符合目标范围。

### 11.2 截图内容

截图包含：

- Logo、主菜单和二级菜单。
- 当前内容页面。
- 已启用的内容水印。
- 当前存在的全部画板笔迹。
- 当前页面可见的业务弹窗和提示。

截图时临时隐藏：

- 截图按钮和画板按钮。
- 二级菜单行中的颜色、粗细和清除工具。

隐藏使用 `visibility: hidden` 保留原宽度，避免截图前后菜单发生布局跳动。账号、续费和窗口控制区第一版保持原样；后续如需更强隐私，可再增加设备号隐藏开关。

### 11.3 一键输出

推荐点击一次后同时完成：

1. 将 PNG 写入系统剪贴板，直播或聊天工具可直接粘贴。
2. 自动保存到 `Pictures/赤狐管家截图/赤狐分享-YYYYMMDD-HHmmss.png`；系统无图片目录时回退到下载目录。
3. 页面显示“截图已复制并保存”的 Toast，并提供“打开目录”操作。

不默认弹出“另存为”对话框，避免直播时遮挡画面。文件写入失败但剪贴板成功时，应明确显示“已复制，保存失败”。

### 11.4 截图时序

```text
用户点击截图
  -> renderer 设置 capturing=true，锁定画板输入
  -> 给分享工具增加 capture-excluded 状态
  -> 等待两帧 requestAnimationFrame，确保隐藏样式完成绘制
  -> IPC 调用 native:sharing:captureMainWindow
  -> main 从 event.sender 获取主 BrowserWindow
  -> webContents.capturePage()
  -> clipboard.writeImage() + PNG 原子写盘
  -> 返回保存路径和图片尺寸
  -> renderer 清除 capture-excluded，恢复画板输入
  -> 显示成功或失败 Toast
```

无论成功、失败还是用户关闭窗口，renderer 都必须在 `finally` 中恢复截图状态。

## 12. IPC 与安全设计

新增单一、窄权限接口：

```ts
window.chihuNative.sharing.captureMainWindow(): Promise<{
  ok: boolean;
  copied: boolean;
  saved: boolean;
  filePath?: string;
  width?: number;
  height?: number;
  message?: string;
}>;
```

主进程约束：

- 通道名：`native:sharing:captureMainWindow`。
- 从 `event.sender` 反查窗口，并验证它就是当前 main 角色窗口；renderer 不能传 `winId` 指定其他窗口。
- renderer 不能传任意保存路径、文件名或图片 Buffer。
- 将通道加入 `electron-client/src/main/license/window-control-policy.js` 的 main-only 列表，由现有 IPC guard 拒绝 runner。
- preload 只暴露上述单一函数，不暴露通用 `capturePage`、文件写入或剪贴板 API。
- 文件名由主进程生成并清洗，写盘使用临时文件后原子重命名。

需要改动：

- `electron-client/src/main/ipc/sharing.js`：截图、复制、写盘。
- `electron-client/src/main/index.js` 或 IPC 注册入口：注册 sharing handlers。
- `electron-client/src/main/license/window-control-policy.js`：main-only 权限。
- `electron-client/src/preload/index.js`：暴露 `sharing.captureMainWindow`。
- `remote-web/client-shell/src/native/types.ts`：补充类型。
- `remote-web/client-shell/src/bridge/client.ts`：增加 renderer 侧封装和错误归一化。

## 13. React 状态与事件流

`App.tsx` 在应用壳层读取偏好并订阅 `addPreferencesListener`，创建 `ShareProvider`：

```ts
interface ShareContextValue {
  preferences: Pick<ChihuPreferences,
    | "shareMaskStoreNames"
    | "shareWatermarkEnabled"
    | "shareWatermarkText"
    | "contentScale"
  >;
  drawing: DrawingState;
  capturing: boolean;
  toggleDrawing(): void;
  setDrawingColor(color: DrawingColor): void;
  setDrawingWidth(width: DrawingWidth): void;
  clearDrawing(): void;
  capture(): Promise<void>;
  displayStoreName(name: string): string;
}
```

`ShellHeader` 只消费动作和状态；`ShareContentSurface` 负责水印、Canvas 和缩放；页面组件通过 `StoreNameText` 或 `useStoreNamePrivacy` 获取显示值。

避免让每个页面自己读取 `localStorage`，否则设置变更会出现不同步，也难以测试。

## 14. 异常与边界处理

- 原生截图桥不存在：按钮禁用或点击后提示“当前版本不支持截图”，不能抛出未捕获异常。
- 连续点击截图：只允许一个进行中的截图请求，后续点击忽略。
- 窗口最小化或销毁：返回可识别错误，不生成空白图片。
- 水印文字为空：不渲染水印并在设置中提示。
- Canvas 尺寸为 0：不进入画板模式。
- 路由切换、窗口尺寸变化或缩放变化：清空笔迹并退出画板。
- 失去窗口焦点或收到 `pointercancel`：立即结束当前笔画，避免持续画线。
- 店名为空或只有空白：保持原有占位，不显示 `***`。
- 设置数据损坏：`normalizePreferences` 回退到安全默认值。
- 截图写盘失败：剪贴板成功和文件保存失败分别报告，不能把整个操作笼统标为失败。

## 15. 实施步骤

### 阶段 A：壳层与设置

1. 扩展 `ChihuPreferences`、默认值和归一化测试。
2. 在设置弹窗增加“分享设置”。
3. 在 `App.tsx` 建立 `ShareProvider` 和 `ShareContentSurface`。
4. 实现内容区水印和三档 CSS `zoom`。

### 阶段 B：店名隐私迁移

1. 实现字素级 `maskStoreName` 和 `StoreNameText`。
2. 迁移 15 个现有页面组件的正文、标题、弹窗和提示。
3. 迁移任务进度等动态文案的显示出口。
4. 店铺子窗口标题根据分享设置传入脱敏后的显示名。
5. 增加静态审计测试，防止新页面直接输出原始店名。

### 阶段 C：画板

1. 在顶部增加画板按钮和二级菜单工具条。
2. 实现 DPR Canvas、Pointer Events、笔画状态和清除。
3. 处理路由、缩放、窗口变化和截图锁定。

### 阶段 D：原生截图

1. 新增 main-only 截图 IPC 和权限测试。
2. preload 与前端类型接入。
3. 实现截图前隐藏工具、两帧同步、复制、保存和 Toast。
4. 在打包后的 Electron 环境完成真实截图验收。

## 16. 测试方案

### 16.1 单元测试

- `maskStoreName`：空值、1-6 个汉字、空格、emoji、生僻字和组合字符。
- 偏好归一化：旧数据缺字段、非法缩放值、超长水印、错误类型。
- 画板 reducer：开始、追加、结束、清除、路由切换和截图锁定。

### 16.2 组件测试

- 设置开关、输入校验、确认与取消。
- 店名正文、`title`、弹窗和动态日志同步脱敏。
- 画板模式工具显示/隐藏，颜色和粗细切换，`Esc` 退出但不清除。
- 内容缩放不影响 84px 菜单头。

### 16.3 Electron/权限测试

- main 页面可以调用截图，runner 调用返回 `IPC_ROLE_DENIED`。
- renderer 无法指定其他窗口或任意文件路径。
- PNG 成功写盘并进入剪贴板。
- 主窗口销毁、写盘失败和剪贴板失败分别返回正确状态。

### 16.4 视觉验收

至少覆盖 `1920x1080`、`1366x768` 和高 DPI `150%` Windows 缩放：

- 水印严格从菜单头下方开始，不覆盖菜单。
- 三档内容缩放下无文字重叠和工具条换行。
- 荧光绿、荧光红和黑色笔迹在浅色页面清晰可见。
- 截图中包含水印和笔迹，且截图/画板工具自身不可见。
- Canvas 像素检查不是全透明或全空白，截图尺寸与 WebContents 可见尺寸一致。
- 开启店名隐藏后，页面、弹窗、动态日志、悬浮提示和子窗口标题不暴露完整店名。

## 17. 验收标准

1. 设置中可以独立开启店名隐藏和水印，并选择 90%、100%、110% 内容大小。
2. 水印只覆盖菜单头以下内容区，页面交互不受影响。
3. 所有赤狐管家控制的可见店名按统一规则脱敏，业务原始数据不变。
4. 主菜单右侧存在截图和画板图标，布局与现有顶栏一致。
5. 画板开启时只有内容区可书写，二级菜单右侧出现三色、三档粗细和清除工具。
6. 关闭画板后笔迹保留，清除后立即消失；路由、缩放或窗口尺寸变化时自动清空。
7. 任意画板模式下都可截图；输出包含菜单头、内容、水印和笔迹。
8. 截图工具自身不进入截图，PNG 同时复制到剪贴板并自动保存。
9. runner 无法调用截图 IPC，renderer 无法读取或截取其他窗口。
10. 打包版 Electron 在普通 DPI 和高 DPI 下截图清晰、无坐标偏移、无空白图。

## 18. 最终建议

本功能应作为“应用壳层分享能力”建设，不应散落到各业务页面。内容缩放采用页面层 CSS `zoom`，截图采用 Electron 原生 `capturePage`，画板采用内容区 DPR Canvas；三者在同一壳层组合，才能保证用户屏幕上看到的水印、脱敏结果和笔迹与最终截图一致。

实施时最大的工作量不是截图或 Canvas，而是店名显示面的完整迁移和防回归。应先建立统一显示组件和静态审计，再逐页替换，避免出现正文已隐藏但弹窗、悬浮提示或动态日志仍泄露店名的情况。
