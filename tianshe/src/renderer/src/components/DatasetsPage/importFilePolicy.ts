export const MAX_IMPORT_RECORDS_FILE_BYTES = 500 * 1024 * 1024;

const SUPPORTED_IMPORT_RECORDS_FILE_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.xlsx',
  '.xls',
]);

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export function assertImportRecordsFileAllowed(
  file: Pick<File, 'name' | 'size'>,
  maxBytes = MAX_IMPORT_RECORDS_FILE_BYTES
): void {
  const extension = file.name.includes('.')
    ? `.${file.name.split('.').pop()}`.toLowerCase()
    : '.csv';

  if (!SUPPORTED_IMPORT_RECORDS_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的导入文件类型：${extension}`);
  }

  if (file.size > maxBytes) {
    throw new Error(
      `文件过大！当前大小: ${formatFileSize(file.size)}，限制大小: ${formatFileSize(maxBytes)}`
    );
  }
}
