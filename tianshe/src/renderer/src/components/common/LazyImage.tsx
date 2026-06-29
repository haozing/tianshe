/**
 * 懒加载图片组件
 * 使用 Intersection Observer API 实现图片懒加载
 */

import React, { useEffect, useRef, useState } from 'react';

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  placeholder?: React.ReactNode;
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  threshold?: number; // 触发加载的阈值 (0-1)
  rootMargin?: string; // 提前加载的距离
}

export const LazyImage = React.memo(function LazyImage({
  src,
  alt,
  className = '',
  placeholder,
  onError,
  threshold = 0.1,
  rootMargin = '50px',
}: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const [hasError, setHasError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!imgRef.current) return;

    // 使用 Intersection Observer 监听元素是否进入视口
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            // 一旦进入视口就停止观察
            observer.disconnect();
          }
        });
      },
      {
        threshold,
        rootMargin,
      }
    );

    observer.observe(imgRef.current);

    return () => {
      observer.disconnect();
    };
  }, [threshold, rootMargin]);

  const handleLoad = () => {
    setIsLoaded(true);
  };

  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setHasError(true);
    onError?.(e);
  };

  // 默认占位符
  const defaultPlaceholder = (
    <div className="w-full h-full bg-gray-100 animate-pulse flex items-center justify-center">
      <span className="text-gray-400 text-xs">...</span>
    </div>
  );

  return (
    <div ref={imgRef} className={`relative ${className}`}>
      {/* 占位符 - 只在图片未加载时显示 */}
      {!isLoaded && !hasError && (
        <div className="absolute inset-0">{placeholder || defaultPlaceholder}</div>
      )}

      {/* 错误占位符 */}
      {hasError && (
        <div className="absolute inset-0 bg-gray-100 flex items-center justify-center">
          <span className="text-gray-400 text-xs">?</span>
        </div>
      )}

      {/* 真实图片 - 只在进入视口时才开始加载 */}
      {isInView && (
        <img
          src={src}
          alt={alt}
          className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
    </div>
  );
});
