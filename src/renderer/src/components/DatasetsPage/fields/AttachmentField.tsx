/**
 * 附件字段组件
 * 支持拖拽上传、文件列表管理
 */

import React, { useState, useRef, useEffect } from 'react';
import { Paperclip, X, Upload, FileText, Film } from 'lucide-react';
import { LazyImage } from '../../common/LazyImage';
import { toast } from '../../../lib/toast';
import { fileFacade } from '../../../services/datasets/fileFacade';

interface UrlAttachment {
  url: string;
  filename: string;
  isImage: boolean;
  isVideo: boolean;
}

export interface AttachmentFieldProps {
  value: string; // 纯文本URL字符串（逗号/分号分隔）
  datasetId: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inlineMode?: boolean; // 内联模式（用于表格单元格）
  separator?: string; // URL分隔符（默认逗号）
  metadata?: any; // 字段元数据
}

export function AttachmentField({
  value,
  datasetId,
  onChange,
  placeholder = '点击或拖拽文件到此处上传',
  inlineMode = false,
  separator = ',',
  metadata,
}: AttachmentFieldProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set()); // 🆕 记录加载失败的图片
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 解析URL列表（从逗号/分号/管道符分隔的字符串）
  const parseUrls = (urlString: string): UrlAttachment[] => {
    if (!urlString || urlString.trim() === '') return [];

    // 尝试检测分隔符
    const detectedSeparator = metadata?.separator || separator;
    const separators = [detectedSeparator, ',', ';', '|', '\n'];

    let urls: string[] = [];
    for (const sep of separators) {
      if (urlString.includes(sep)) {
        urls = urlString
          .split(sep)
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
        break;
      }
    }

    if (urls.length === 0) {
      urls = [urlString.trim()];
    }

    return urls.map((url) => ({
      url,
      filename: url.split('/').pop() || url,
      isImage: /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(url),
      isVideo: /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(url),
    }));
  };

  const attachments = parseUrls(value);

  // 加载本地图片的Base64数据（优化：只加载新的图片，避免重复加载）
  useEffect(() => {
    const loadLocalImages = async () => {
      const newUrls: Record<string, string> = { ...imageUrls };
      const newFailedImages = new Set(failedImages);
      let hasNewImages = false;
      let hasNewFailures = false;

      for (const attachment of attachments) {
        // 跳过已加载的图片和已知失败的图片
        if (newUrls[attachment.url] || newFailedImages.has(attachment.url)) continue;

        // 如果不是HTTP/HTTPS URL，认为是本地路径，需要加载Base64
        if (!attachment.url.startsWith('http://') && !attachment.url.startsWith('https://')) {
          if (attachment.isImage) {
            try {
              const response = await fileFacade.getImageData(attachment.url);
              if (response.success && response.data) {
                newUrls[attachment.url] = response.data; // Base64 data URL
                hasNewImages = true;
              } else {
                // 🆕 加载失败，记录但不抛出错误
                newFailedImages.add(attachment.url);
                hasNewFailures = true;
              }
            } catch (_error) {
              // 🆕 静默处理错误，记录失败的图片
              console.warn('[AttachmentField] Image file not found:', attachment.url);
              newFailedImages.add(attachment.url);
              hasNewFailures = true;
            }
          }
        }
      }

      // 只在有新图片或新失败时才更新状态
      if (hasNewImages) {
        setImageUrls(newUrls);
      }
      if (hasNewFailures) {
        setFailedImages(newFailedImages);
      }
    };

    if (attachments.length > 0) {
      loadLocalImages();
    }
  }, [value]); // 注意：这里保留 imageUrls 的依赖会导致循环，所以移除它

  // 上传文件
  const uploadFile = async (file: File) => {
    try {
      setIsUploading(true);

      // 读取文件数据
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Array.from(new Uint8Array(arrayBuffer));

      // 调用API上传
      const response = await fileFacade.upload(datasetId, {
        buffer,
        filename: file.name,
      });

      if (response.success && response.metadata) {
        // 获取上传后的文件路径/URL
        const newUrl = response.metadata.path || response.metadata.url;

        // 添加到URL列表（使用逗号分隔）
        const detectedSeparator = metadata?.separator || separator;
        const newValue = value ? `${value}${detectedSeparator}${newUrl}` : newUrl;
        onChange(newValue);

        // 上传成功后关闭上传面板（inline 模式）
        if (inlineMode) {
          setShowUploadPanel(false);
        }
      } else {
        toast.error('上传失败', response.error || '未知错误');
      }
    } catch (error: any) {
      console.error('[AttachmentField] Upload error:', error);
      toast.error('上传失败', error.message);
    } finally {
      setIsUploading(false);
    }
  };

  // 删除URL
  const deleteUrl = async (urlToDelete: string) => {
    try {
      // 如果是本地文件路径，尝试删除物理文件
      if (!urlToDelete.startsWith('http://') && !urlToDelete.startsWith('https://')) {
        const response = await fileFacade.delete(urlToDelete);
        if (!response.success && response.error) {
          console.warn('[AttachmentField] Failed to delete file:', response.error);
        }
      }

      // 从URL列表中移除
      const urls = attachments.map((a) => a.url).filter((u) => u !== urlToDelete);
      const detectedSeparator = metadata?.separator || separator;
      const newValue = urls.join(detectedSeparator);
      onChange(newValue);
    } catch (error: any) {
      console.error('[AttachmentField] Delete error:', error);
      toast.error('删除失败', error.message);
    }
  };

  // 打开URL
  const openUrl = (url: string) => {
    // 对于HTTP(S) URL，在新标签页打开
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      // 对于本地文件路径，使用electron API打开
      fileFacade.open(url).catch((error: any) => {
        console.error('[AttachmentField] Open error:', error);
        toast.error('打开文件失败', error.message || '未知错误');
      });
    }
  };

  // 处理文件选择
  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    // 上传第一个文件（可扩展为多文件上传）
    uploadFile(files[0]);
  };

  // 拖拽事件
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    handleFileSelect(files);
  };

  // 点击外部关闭上传面板
  useEffect(() => {
    if (!inlineMode || !showUploadPanel) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowUploadPanel(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [inlineMode, showUploadPanel]);

  // Inline 模式：显示缩略图列表，点击空白区域上传
  if (inlineMode) {
    return (
      <div ref={containerRef} className="relative w-full min-h-[32px]">
        <div
          className={`
            shell-field-control shell-field-control--inline flex min-h-[34px] cursor-pointer flex-wrap items-center gap-1.5 p-1.5
            ${showUploadPanel ? 'shell-field-control--active' : ''}
          `}
          onClick={(e) => {
            // 点击空白区域显示上传面板
            if ((e.target as HTMLElement).closest('.attachment-thumbnail')) {
              return; // 如果点击的是缩略图，不显示上传面板
            }
            setShowUploadPanel(!showUploadPanel);
          }}
        >
          {/* 显示现有附件的缩略图 */}
          {attachments.map((attachment, idx) => (
            <div key={`${attachment.url}-${idx}`} className="relative group attachment-thumbnail">
              {attachment.isImage ? (
                <div
                  className="h-8 w-8 overflow-hidden rounded-[10px] border border-slate-200 bg-white shadow-sm transition-opacity hover:opacity-80"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(attachment.url);
                  }}
                >
                  {/* 🆕 如果图片加载失败，显示占位符 */}
                  {failedImages.has(attachment.url) ? (
                    <div
                      className="flex h-full w-full items-center justify-center text-slate-400"
                      title="文件不存在"
                    >
                      <FileText className="w-4 h-4" />
                    </div>
                  ) : imageUrls[attachment.url] || attachment.url.startsWith('http') ? (
                    <LazyImage
                      src={imageUrls[attachment.url] || attachment.url}
                      alt={attachment.filename}
                      className="w-full h-full object-cover"
                      threshold={0.1}
                      rootMargin="100px"
                      onError={(_e) => {
                        console.warn('[AttachmentField] Image render error:', attachment.url);
                      }}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-slate-300">
                      ...
                    </div>
                  )}
                </div>
              ) : attachment.isVideo ? (
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-slate-200 bg-white shadow-sm transition-colors hover:bg-slate-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(attachment.url);
                  }}
                >
                  <Film className="w-4 h-4 text-slate-400" />
                </div>
              ) : (
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-slate-200 bg-white shadow-sm transition-colors hover:bg-slate-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(attachment.url);
                  }}
                >
                  <FileText className="w-4 h-4 text-slate-400" />
                </div>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteUrl(attachment.url);
                }}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {attachments.length === 0 && !isUploading && (
            <span className="px-1 text-xs text-slate-400">点击上传附件</span>
          )}

          {isUploading && <span className="px-1 text-xs text-slate-400">上传中...</span>}
        </div>

        {showUploadPanel && (
          <div className="shell-field-panel absolute left-0 top-full z-50 mt-2 min-w-[296px] p-4">
            <div
              className={`
                shell-upload-dropzone p-6 text-center cursor-pointer
                ${isDragging ? 'shell-upload-dropzone--dragging' : ''}
                ${isUploading ? 'opacity-50 pointer-events-none' : ''}
              `}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="mx-auto mb-2 h-8 w-8 text-slate-400" />
              <p className="mb-1 text-sm text-slate-600">
                {isUploading ? '上传中...' : '点击或拖拽文件到此处'}
              </p>
              <p className="text-xs text-slate-400">支持图片、视频、文档等</p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
            />
          </div>
        )}
      </div>
    );
  }

  // 普通模式：完整的上传界面
  return (
    <div className="w-full">
      {attachments.length === 0 ? (
        <div
          className={`
            shell-upload-dropzone p-6 text-center cursor-pointer
            ${isDragging ? 'shell-upload-dropzone--dragging' : ''}
            ${isUploading ? 'opacity-50 pointer-events-none' : ''}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mx-auto mb-2 h-8 w-8 text-slate-400" />
          <p className="mb-1 text-sm text-slate-600">{isUploading ? '上传中...' : placeholder}</p>
          <p className="text-xs text-slate-400">支持所有文件类型</p>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {attachments.map((attachment, idx) => (
            <div
              key={`${attachment.url}-${idx}`}
              className="shell-soft-card group flex items-center justify-between px-3 py-2 transition-colors hover:shadow-md"
            >
              <div
                className="flex items-center gap-2 flex-1 cursor-pointer min-w-0"
                onClick={() => openUrl(attachment.url)}
              >
                {attachment.isImage ? (
                  failedImages.has(attachment.url) ? (
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400"
                      title="文件不存在"
                    >
                      <FileText className="w-5 h-5" />
                    </div>
                  ) : imageUrls[attachment.url] || attachment.url.startsWith('http') ? (
                    <LazyImage
                      src={imageUrls[attachment.url] || attachment.url}
                      alt={attachment.filename}
                      className="w-10 h-10 object-cover rounded border border-gray-200"
                      threshold={0.1}
                      rootMargin="100px"
                      onError={(_e) => {
                        console.warn('[AttachmentField] Image render error:', attachment.url);
                      }}
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-xs text-slate-400">
                      ...
                    </div>
                  )
                ) : attachment.isVideo ? (
                  <Film className="w-4 h-4 text-slate-400" />
                ) : (
                  <Paperclip className="w-4 h-4 text-slate-400" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-slate-700">{attachment.filename}</p>
                  <p className="truncate text-xs text-slate-400">{attachment.url}</p>
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteUrl(attachment.url);
                }}
                className="shell-icon-button rounded-full p-1 text-slate-400 opacity-0 transition-all group-hover:opacity-100 hover:text-red-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="shell-field-control flex w-full items-center justify-center gap-2 px-3 py-2 text-sm text-slate-600 transition-colors hover:text-slate-900 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            <span>{isUploading ? '上传中...' : '添加本地文件'}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)}
          />
        </div>
      )}
    </div>
  );
}
