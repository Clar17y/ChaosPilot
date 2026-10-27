import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const htmlUrl = new URL('../public/index.html', import.meta.url);

describe('browser entry point', () => {
  it('loads the TypeScript compiler output as an ES module', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]!);
    const applicationScript = scripts.find(attributes => /\bsrc=["']\/app\.js["']/.test(attributes));
    expect(applicationScript).toBeDefined();
    expect(applicationScript).toMatch(/\btype=["']module["']/);
  });

  it('ships the reproduction player controls with accessible labels', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    for (const id of ['reproduction-player', 'btn-repro-prev', 'btn-repro-next', 'btn-repro-play', 'btn-repro-reset', 'btn-repro-rerun', 'repro-timeline']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('recorded playback only');
    expect(html).not.toContain('Concept — not implemented');
  });

  it('does not offer the unsupported inventory adapter as executable', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).not.toContain('Executable synthetic inventory reservation');
    const option = html.match(/<option\b[^>]*value=["']inventory-reservation["'][^>]*>/)?.[0];
    expect(option).toBeDefined();
    expect(option).toMatch(/\bdisabled\b/);
    expect(html).toContain('not available on this server');
  });

  it('does not reveal planted fault classes in target choices', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const choices = html.match(/<select\b[^>]*id=["']target-select["'][^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(choices).toBeDefined();
    expect(choices).not.toMatch(/Idempotency|Redelivery|Fill Race/i);
  });
});
