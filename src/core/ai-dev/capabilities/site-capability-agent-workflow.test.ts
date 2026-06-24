// @tianshe-test area=http-mcp layer=unit runtime=node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGuideContent, buildInitializeInstructions } from '../../../main/mcp-guidance-content';

const root = path.resolve(__dirname, '../../../..');

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('site capability agent workflow', () => {
  it('teaches the default MCP guide to discover business capabilities before browser fallback', () => {
    const guide = buildGuideContent('getting_started');
    const instructions = buildInitializeInstructions();

    expect(guide).toContain('site_capability_list');
    expect(guide).toContain('<site>.<action>');
    expect(instructions).toContain('site_capability_list');
    expect(instructions).toContain('<site>.<action>');
  });

  it('keeps the playbook focused on business capabilities and explicit browser fallback', () => {
    const playbook = readDoc('docs/agent-site-capability-playbook.zh-CN.md');

    expect(playbook).toContain('site_capability_list');
    expect(playbook).toContain('books_to_scrape.extract_product');
    expect(playbook).toContain('dataset_get_record_provenance');
    expect(playbook).toContain('browser_observe');
    expect(playbook).toContain('没有成熟匹配能力');
  });

  it('keeps the golden transcript off raw Playwright and selector scripting', () => {
    const transcript = readDoc('docs/evidence/golden-transcripts/site-capability-default-flow.md');

    expect(transcript).toContain('site_capability_list');
    expect(transcript).toContain('books_to_scrape.extract_product');
    expect(transcript).toContain('dataset_get_record_provenance');
    expect(transcript).not.toMatch(/playwright|page\.|locator|selector|evaluate/i);
  });
});
