import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_SURFACE_FILES = [
  'src/core/ai-dev/capabilities/browser/tool-definitions.ts',
  'src/core/ai-dev/capabilities/assistant-guidance.ts',
  'src/main/mcp-guidance-content.ts',
  'src/main/mcp-http-catalog.ts',
];

const SUSPICIOUS_MOJIBAKE_SNIPPETS = ['\uFFFD', '鍙', '锛', '銆', '鈥'];

describe('mcp public strings', () => {
  it('keeps the canonical public-surface sources NFC-normalized and free of mojibake markers', () => {
    for (const relativePath of PUBLIC_SURFACE_FILES) {
      const absolutePath = resolve(relativePath);
      const content = readFileSync(absolutePath, 'utf8');

      expect(content, `${relativePath} must remain NFC-normalized`).toBe(content.normalize('NFC'));
      for (const marker of SUSPICIOUS_MOJIBAKE_SNIPPETS) {
        expect(content.includes(marker), `${relativePath} contains mojibake marker "${marker}"`).toBe(false);
      }
    }
  });
});
