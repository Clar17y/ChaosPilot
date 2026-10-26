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

  it('does not reveal planted fault classes in target choices', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const choices = html.match(/<select\b[^>]*id=["']target-select["'][^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(choices).toBeDefined();
    expect(choices).not.toMatch(/Idempotency|Redelivery|Fill Race/i);
  });
});
