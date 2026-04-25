export function buildAcceptLanguageHeaderValue(languages: string[]): string {
  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(languages) ? languages : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
  }

  if (cleaned.length === 0) return '';

  const parts: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const lang = cleaned[i];
    if (i === 0) {
      parts.push(lang);
      continue;
    }

    const q = Math.max(0.1, Number((1 - i * 0.1).toFixed(1)));
    parts.push(`${lang};q=${q}`);
  }

  return parts.join(',');
}
