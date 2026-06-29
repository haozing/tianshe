export function parseDownloadFilenameFromContentDisposition(
  contentDisposition: string | null
): string {
  const raw = String(contentDisposition || '').trim();
  if (!raw) return '';

  const utf8Match = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim();
    } catch {
      return String(utf8Match[1]).trim();
    }
  }

  const quotedMatch = raw.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const plainMatch = raw.match(/filename\s*=\s*([^;]+)/i);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim();
  }

  return '';
}

export function sanitizeZipFilename(rawName: string, fallback: string): string {
  const normalized = String(rawName || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
  const candidate = normalized || fallback;
  return candidate.toLowerCase().endsWith('.zip') ? candidate : `${candidate}.zip`;
}
