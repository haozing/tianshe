/**
 * 浏览器截图/导出 API
 *
 * 提供截图、PDF 导出等页面捕获功能。
 *
 * @example
 * // 截图为 Buffer（通过 SimpleBrowser 实例访问）
 * const buffer = await browser.capture.screenshot();
 *
 * @example
 * // 截图保存到文件
 * await browser.capture.screenshotToFile('./screenshot.png');
 *
 * @example
 * // 导出 PDF
 * const pdfBuffer = await browser.capture.pdf({ landscape: true });
 */

import type { WebContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 截图选项
 */
export interface ScreenshotOptions {
  /**
   * 截图区域
   * 如果不指定，则截取整个可见视口
   */
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 图片格式 */
  format?: 'png' | 'jpeg';
  /** JPEG 质量（1-100，仅 format='jpeg' 时有效） */
  quality?: number;
}

/**
 * PDF 导出选项
 */
export interface PDFOptions {
  /** 是否横向（默认：false，纵向） */
  landscape?: boolean;
  /** 是否显示页眉页脚 */
  displayHeaderFooter?: boolean;
  /** 是否打印背景 */
  printBackground?: boolean;
  /** 缩放比例（0.1-2.0，默认 1） */
  scale?: number;
  /**
   * 页面大小
   * 预设值或自定义尺寸（单位：微米）
   */
  pageSize?:
    | 'A4'
    | 'A3'
    | 'A5'
    | 'Letter'
    | 'Legal'
    | 'Tabloid'
    | { width: number; height: number };
  /**
   * 页边距（单位：微米）
   * 1 英寸 = 25400 微米
   */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** 页眉 HTML 模板 */
  headerTemplate?: string;
  /** 页脚 HTML 模板 */
  footerTemplate?: string;
  /** 页面范围（如 '1-5, 8, 11-13'） */
  pageRanges?: string;
  /** 是否优先使用 CSS @page 尺寸 */
  preferCSSPageSize?: boolean;
}

/**
 * 浏览器截图/导出 API
 */
export class BrowserCaptureAPI {
  constructor(private getWebContents: () => WebContents) {}

  // ========================================
  // 截图
  // ========================================

  /**
   * 截图（返回 Buffer）
   *
   * @param options 截图选项
   * @returns 图片数据 Buffer
   *
   * @example
   * const buffer = await browser.capture.screenshot();
   *
   * @example
   * // 截取特定区域
   * const buffer = await browser.capture.screenshot({
   *   rect: { x: 0, y: 0, width: 800, height: 600 }
   * });
   *
   * @example
   * // JPEG 格式，80% 质量
   * const buffer = await browser.capture.screenshot({
   *   format: 'jpeg',
   *   quality: 80
   * });
   */
  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const webContents = this.getWebContents();
    const image = await webContents.capturePage(options?.rect);

    if (options?.format === 'jpeg') {
      return image.toJPEG(options.quality ?? 80);
    }
    return image.toPNG();
  }

  /**
   * 截图并保存到文件
   *
   * @param filePath 保存路径
   * @param options 截图选项
   *
   * @example
   * await browser.capture.screenshotToFile('./screenshots/page.png');
   */
  async screenshotToFile(filePath: string, options?: ScreenshotOptions): Promise<void> {
    const buffer = await this.screenshot(options);

    // 确保目录存在
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
  }

  /**
   * 截图为 Base64 字符串
   *
   * @param options 截图选项
   * @returns Base64 编码的图片数据
   *
   * @example
   * const base64 = await browser.capture.screenshotAsBase64();
   */
  async screenshotAsBase64(options?: ScreenshotOptions): Promise<string> {
    const buffer = await this.screenshot(options);
    return buffer.toString('base64');
  }

  /**
   * 截图为 Data URL
   *
   * @param options 截图选项
   * @returns Data URL 格式的图片
   *
   * @example
   * const dataUrl = await browser.capture.screenshotAsDataURL();
   * // 'data:image/png;base64,...'
   */
  async screenshotAsDataURL(options?: ScreenshotOptions): Promise<string> {
    const webContents = this.getWebContents();
    const image = await webContents.capturePage(options?.rect);
    return image.toDataURL();
  }

  /**
   * 截取元素（通过选择器）
   *
   * @param selector CSS 选择器
   * @param options 截图选项（rect 会被忽略）
   * @returns 图片数据 Buffer
   *
   * @example
   * const buffer = await browser.capture.screenshotElement('#main-content');
   */
  async screenshotElement(
    selector: string,
    options?: Omit<ScreenshotOptions, 'rect'>
  ): Promise<Buffer> {
    const webContents = this.getWebContents();

    // 获取元素边界
    const rect = await webContents.executeJavaScript(`
      (function() {
        const selector = ${JSON.stringify(selector)};
        const textMatch = selector.match(/^(.+):has-text\\("(.+)"\\)$/);
        const visibleMatch = selector.match(/^(.+):visible$/);
        let el = null;

        if (textMatch) {
          const [, baseSelector, text] = textMatch;
          const candidates = document.querySelectorAll(baseSelector);
          el = Array.from(candidates).find((item) => item.textContent?.includes(text)) || null;
        } else if (visibleMatch) {
          const [, baseSelector] = visibleMatch;
          const candidates = document.querySelectorAll(baseSelector);
          el =
            Array.from(candidates).find((item) => {
              const style = getComputedStyle(item);
              const rect = item.getBoundingClientRect();
              return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0;
            }) || null;
        } else {
          el = document.querySelector(selector);
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        };
      })()
    `);

    if (!rect) {
      throw new Error(`Element not found: ${selector}`);
    }

    return this.screenshot({ ...options, rect });
  }

  // ========================================
  // PDF 导出
  // ========================================

  /**
   * 导出 PDF（返回 Buffer）
   *
   * @param options PDF 选项
   * @returns PDF 数据 Buffer
   *
   * @example
   * const buffer = await browser.capture.pdf();
   *
   * @example
   * // 横向 A3
   * const buffer = await browser.capture.pdf({
   *   landscape: true,
   *   pageSize: 'A3'
   * });
   */
  async pdf(options?: PDFOptions): Promise<Buffer> {
    const webContents = this.getWebContents();

    return webContents.printToPDF({
      landscape: options?.landscape ?? false,
      displayHeaderFooter: options?.displayHeaderFooter ?? false,
      printBackground: options?.printBackground ?? true,
      scale: options?.scale ?? 1,
      pageSize: options?.pageSize ?? 'A4',
      margins: options?.margins,
      headerTemplate: options?.headerTemplate,
      footerTemplate: options?.footerTemplate,
      pageRanges: options?.pageRanges,
      preferCSSPageSize: options?.preferCSSPageSize,
    });
  }

  /**
   * 导出 PDF 并保存到文件
   *
   * @param filePath 保存路径
   * @param options PDF 选项
   *
   * @example
   * await browser.capture.pdfToFile('./exports/report.pdf');
   */
  async pdfToFile(filePath: string, options?: PDFOptions): Promise<void> {
    const buffer = await this.pdf(options);

    // 确保目录存在
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
  }

  /**
   * 导出 PDF 为 Base64
   *
   * @param options PDF 选项
   * @returns Base64 编码的 PDF 数据
   */
  async pdfAsBase64(options?: PDFOptions): Promise<string> {
    const buffer = await this.pdf(options);
    return buffer.toString('base64');
  }

  // ========================================
  // HTML 导出
  // ========================================

  /**
   * 获取页面 HTML
   *
   * @returns 页面完整 HTML
   *
   * @example
   * const html = await browser.capture.getHTML();
   */
  async getHTML(): Promise<string> {
    const webContents = this.getWebContents();
    return webContents.executeJavaScript('document.documentElement.outerHTML');
  }

  /**
   * 获取页面 HTML 并保存到文件
   *
   * @param filePath 保存路径
   *
   * @example
   * await browser.capture.saveHTML('./exports/page.html');
   */
  async saveHTML(filePath: string): Promise<void> {
    const html = await this.getHTML();

    // 确保目录存在
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, html, 'utf-8');
  }

  // ========================================
  // MHTML 导出（完整网页存档）
  // ========================================

  /**
   * 保存为 MHTML（完整网页存档）
   *
   * MHTML 格式会将页面所有资源（图片、CSS、JS）打包到一个文件中。
   *
   * @param filePath 保存路径
   *
   * @example
   * await browser.capture.saveMHTML('./archives/page.mhtml');
   */
  async saveMHTML(filePath: string): Promise<void> {
    const webContents = this.getWebContents();

    // 确保目录存在
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    // 使用 Electron 的 savePage API
    await webContents.savePage(filePath, 'MHTML');
  }
}
