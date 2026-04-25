/**
 * 防抖函数工具
 * 限制函数的执行频率，只在最后一次调用后执行
 */

/**
 * 防抖函数
 *
 * 使用场景：
 * - 窗口resize事件
 * - 输入框搜索
 * - 滚动事件
 *
 * @example
 * ```typescript
 * const debouncedResize = debounce(() => {
 *   console.log('Window resized');
 * }, 300);
 *
 * window.addEventListener('resize', debouncedResize);
 * ```
 *
 * @param func - 需要防抖的函数
 * @param wait - 等待时间(ms)
 * @returns 防抖后的函数
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function (this: any, ...args: Parameters<T>) {
    const context = this;

    // 清除之前的定时器
    if (timeout) {
      clearTimeout(timeout);
    }

    // 设置新的定时器
    timeout = setTimeout(() => {
      func.apply(context, args);
      timeout = null;
    }, wait);
  };
}

/**
 * 节流函数
 * 限制函数的执行频率，在指定时间内只执行一次
 *
 * 与防抖的区别：
 * - 防抖：等待停止后才执行
 * - 节流：每隔一段时间执行一次
 *
 * @example
 * ```typescript
 * const throttledScroll = throttle(() => {
 *   console.log('Scrolled');
 * }, 1000);
 *
 * window.addEventListener('scroll', throttledScroll);
 * ```
 *
 * @param func - 需要节流的函数
 * @param wait - 等待时间(ms)
 * @returns 节流后的函数
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  let lastRun: number = 0;

  return function (this: any, ...args: Parameters<T>) {
    const context = this;
    const now = Date.now();

    if (!lastRun || now - lastRun >= wait) {
      // 立即执行
      func.apply(context, args);
      lastRun = now;
    } else {
      // 清除之前的定时器
      if (timeout) {
        clearTimeout(timeout);
      }

      // 设置定时器，确保最后一次调用被执行
      timeout = setTimeout(
        () => {
          func.apply(context, args);
          lastRun = Date.now();
          timeout = null;
        },
        wait - (now - lastRun)
      );
    }
  };
}
