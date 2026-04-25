/**
 * 浏览器原生输入 API
 *
 * 提供 isTrusted=true 的原生输入事件，用于绕过网站的自动化检测。
 *
 * 与 JS 触发的事件不同，原生事件：
 * - isTrusted = true
 * - 由操作系统级别的输入队列处理
 * - 更难被检测为自动化行为
 *
 * @example
 * // 原生点击（通过 SimpleBrowser 实例访问）
 * const bounds = await browser.getElementBounds('#button');
 * await browser.native.click(bounds.centerX, bounds.centerY);
 *
 * @example
 * // 原生键盘输入
 * await browser.native.type('Hello World');
 * await browser.native.keyPress('Enter');
 */

import type { WebContents } from 'electron';
import { sleep } from './utils';

/**
 * 原生点击选项
 */
export interface NativeClickOptions {
  /** 鼠标按钮 */
  button?: 'left' | 'right' | 'middle';
  /** 点击次数（1=单击，2=双击，3=三击） */
  clickCount?: 1 | 2 | 3;
  /** mouseDown 和 mouseUp 之间的延迟（毫秒） */
  delay?: number;
}

/**
 * 原生输入选项
 */
export interface NativeTypeOptions {
  /** 每个字符之间的延迟（毫秒） */
  delay?: number;
}

/**
 * 原生拖拽选项
 */
export interface NativeDragOptions {
  /** 拖拽过程中的步数（越多越平滑） */
  steps?: number;
  /** 每步之间的延迟（毫秒） */
  stepDelay?: number;
}

/**
 * 浏览器原生输入 API
 *
 * 所有方法都使用 Electron 的 sendInputEvent API，
 * 产生的事件具有 isTrusted=true 属性。
 */
export class BrowserNativeAPI {
  constructor(private getWebContents: () => WebContents) {}

  /**
   * 原生鼠标点击
   *
   * @param x X 坐标（相对于视口）
   * @param y Y 坐标（相对于视口）
   * @param options 点击选项
   *
   * @example
   * // 单击
   * await browser.native.click(100, 200);
   *
   * @example
   * // 双击
   * await browser.native.click(100, 200, { clickCount: 2 });
   *
   * @example
   * // 右键点击
   * await browser.native.click(100, 200, { button: 'right' });
   */
  async click(x: number, y: number, options?: NativeClickOptions): Promise<void> {
    const webContents = this.getWebContents();
    const button = options?.button || 'left';
    const clickCount = options?.clickCount || 1;
    const delay = options?.delay ?? 50;

    // 1. 移动鼠标到目标位置
    webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(10);

    // 2. 按下鼠标
    webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button,
      clickCount,
    });

    // 3. 等待
    await sleep(delay);

    // 4. 释放鼠标
    webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y,
      button,
      clickCount,
    });
  }

  /**
   * 原生鼠标移动
   *
   * @param x 目标 X 坐标
   * @param y 目标 Y 坐标
   *
   * @example
   * await browser.native.move(100, 200);
   */
  async move(x: number, y: number): Promise<void> {
    const webContents = this.getWebContents();
    webContents.sendInputEvent({ type: 'mouseMove', x, y });
  }

  /**
   * 平滑鼠标移动（模拟真实用户）
   *
   * @param fromX 起始 X 坐标
   * @param fromY 起始 Y 坐标
   * @param toX 目标 X 坐标
   * @param toY 目标 Y 坐标
   * @param steps 移动步数（默认 10）
   * @param stepDelay 每步延迟（默认 10ms）
   *
   * @example
   * await browser.native.smoothMove(0, 0, 100, 200, 20, 5);
   */
  async smoothMove(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number = 10,
    stepDelay: number = 10
  ): Promise<void> {
    const webContents = this.getWebContents();

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const x = Math.round(fromX + (toX - fromX) * progress);
      const y = Math.round(fromY + (toY - fromY) * progress);

      webContents.sendInputEvent({ type: 'mouseMove', x, y });

      if (i < steps) {
        await sleep(stepDelay);
      }
    }
  }

  /**
   * 原生拖拽
   *
   * @param fromX 起始 X 坐标
   * @param fromY 起始 Y 坐标
   * @param toX 目标 X 坐标
   * @param toY 目标 Y 坐标
   * @param options 拖拽选项
   *
   * @example
   * await browser.native.drag(100, 100, 300, 300);
   */
  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options?: NativeDragOptions
  ): Promise<void> {
    const webContents = this.getWebContents();
    const steps = options?.steps ?? 10;
    const stepDelay = options?.stepDelay ?? 10;

    // 1. 移动到起始位置
    webContents.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY });
    await sleep(10);

    // 2. 按下鼠标
    webContents.sendInputEvent({
      type: 'mouseDown',
      x: fromX,
      y: fromY,
      button: 'left',
      clickCount: 1,
    });
    await sleep(50);

    // 3. 平滑移动到目标位置
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const x = Math.round(fromX + (toX - fromX) * progress);
      const y = Math.round(fromY + (toY - fromY) * progress);

      webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await sleep(stepDelay);
    }

    // 4. 释放鼠标
    webContents.sendInputEvent({
      type: 'mouseUp',
      x: toX,
      y: toY,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * 原生键盘输入文本
   *
   * 逐字符输入，模拟真实打字。
   *
   * @param text 要输入的文本
   * @param options 输入选项
   *
   * @example
   * await browser.native.type('Hello World');
   *
   * @example
   * // 慢速输入
   * await browser.native.type('Hello', { delay: 100 });
   */
  async type(text: string, options?: NativeTypeOptions): Promise<void> {
    const webContents = this.getWebContents();
    const delay = options?.delay ?? 50;

    for (const char of text) {
      webContents.sendInputEvent({ type: 'char', keyCode: char });

      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  /**
   * 原生按键（支持特殊键）
   *
   * @param key 按键名称（如 'Enter', 'Tab', 'Escape', 'a', 'A'）
   * @param modifiers 修饰键
   *
   * @example
   * // 按 Enter
   * await browser.native.keyPress('Enter');
   *
   * @example
   * // Ctrl+A 全选
   * await browser.native.keyPress('a', ['control']);
   *
   * @example
   * // Ctrl+Shift+I 打开开发者工具
   * await browser.native.keyPress('i', ['control', 'shift']);
   */
  async keyPress(key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]): Promise<void> {
    const webContents = this.getWebContents();

    // keyDown
    webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    });

    await sleep(10);

    // keyUp
    webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    });
  }

  /**
   * 按住按键（不释放）
   *
   * 用于组合键操作，需要配合 keyUp 使用。
   *
   * @param key 按键名称
   * @param modifiers 修饰键
   *
   * @example
   * await browser.native.keyDown('Shift');
   * await browser.native.click(100, 100); // Shift+点击
   * await browser.native.keyUp('Shift');
   */
  async keyDown(key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]): Promise<void> {
    const webContents = this.getWebContents();
    webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    });
  }

  /**
   * 释放按键
   *
   * @param key 按键名称
   * @param modifiers 修饰键
   */
  async keyUp(key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]): Promise<void> {
    const webContents = this.getWebContents();
    webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    });
  }

  /**
   * 原生滚轮事件
   *
   * @param x 鼠标 X 坐标
   * @param y 鼠标 Y 坐标
   * @param deltaX 水平滚动量（正值向右）
   * @param deltaY 垂直滚动量（正值向下）
   *
   * @example
   * // 向下滚动
   * await browser.native.scroll(100, 100, 0, 100);
   *
   * @example
   * // 向上滚动
   * await browser.native.scroll(100, 100, 0, -100);
   */
  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const webContents = this.getWebContents();
    webContents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  /**
   * 平滑滚动（模拟真实用户）
   *
   * @param x 鼠标 X 坐标
   * @param y 鼠标 Y 坐标
   * @param totalDeltaY 总滚动量
   * @param steps 滚动步数（默认 5）
   * @param stepDelay 每步延迟（默认 50ms）
   *
   * @example
   * // 平滑向下滚动 500 像素
   * await browser.native.smoothScroll(100, 100, 500, 10, 30);
   */
  async smoothScroll(
    x: number,
    y: number,
    totalDeltaY: number,
    steps: number = 5,
    stepDelay: number = 50
  ): Promise<void> {
    const webContents = this.getWebContents();
    const deltaPerStep = totalDeltaY / steps;

    for (let i = 0; i < steps; i++) {
      webContents.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: deltaPerStep,
      });

      if (i < steps - 1) {
        await sleep(stepDelay);
      }
    }
  }
}
