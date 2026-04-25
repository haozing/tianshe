# 应用图标说明

## 当前状态

本项目使用 Electron 默认图标作为临时图标。

## 如何替换为自定义图标

### 方法一：使用在线工具

1. 访问 https://www.iconfinder.com/icon-converter
2. 上传您的图片（推荐 1024x1024 PNG）
3. 生成以下格式：
   - `icon.ico` - Windows 图标（256x256）
   - `icon.icns` - macOS 图标
   - `icon.png` - Linux 图标（512x512）
4. 将生成的文件放入 `build/` 目录

### 方法二：使用 electron-icon-builder

```bash
npm install -g electron-icon-builder
electron-icon-builder --input=./your-logo.png --output=./build --flatten
```

### 方法三：手动创建

**Windows (.ico):**
- 推荐尺寸：256x256
- 工具：GIMP、Photoshop、在线转换器

**macOS (.icns):**
- 需要包含多种尺寸（16x16 到 1024x1024）
- 工具：Image2icon、Icon Slate

**Linux (.png):**
- 推荐尺寸：512x512
- 直接使用 PNG 格式

## 图标设计建议

- 使用简洁的设计
- 避免过多细节（小尺寸下难以辨认）
- 使用高对比度颜色
- 保持正方形比例
- 支持透明背景

## 当前文件

- `build/icon.ico` - Windows 图标（Electron 默认）
- `build/icon.icns` - macOS 图标（需要创建）
- `build/icon.png` - Linux 图标（需要创建）
