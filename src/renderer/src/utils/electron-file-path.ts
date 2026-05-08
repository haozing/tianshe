type FileWithOptionalPath = File & { path?: string };

export function getNativePathForFile(file: FileWithOptionalPath): string {
  return file.path || window.electronAPI?.files?.getPathForFile?.(file) || '';
}
