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
    expect(html).toContain('id="repro-evidence-heading"');
    expect(html).toContain('Original finding summary (historical)');
    expect(html).not.toContain('Concept — not implemented');
  });

  it('collapses provenance accessibly and puts playback controls first in the detail area', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const provenance = html.match(/<details\b[^>]*id=["']repro-provenance["'][^>]*>([\s\S]*?)<\/details>/)?.[1];
    expect(provenance).toBeDefined();
    expect(provenance).toContain('<summary>Run and source provenance</summary>');
    expect(provenance).toContain('id="repro-provenance-items"');
    expect(provenance).not.toMatch(/\bopen\b/);
    // Controls precede the long step detail.
    expect(html.indexOf('id="btn-repro-play"')).toBeLessThan(html.indexOf('id="repro-step-title"'));
    expect(html.indexOf('id="btn-repro-play"')).toBeLessThan(html.indexOf('id="repro-expected"'));
    expect(html.match(/id=["']btn-repro-play["']/g)).toHaveLength(1);
  });

  it('wires fresh reruns through the full session classification, not a collapsed mapping', async () => {
    const app = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
    expect(app).toContain('settleFreshReport(');
    expect(app).toContain('settleFreshError(');
    expect(app).not.toContain("kind === 'success' ?");
    // Fresh view is labelled playback of the completed rerun; the new-run
    // default selection goes through the production session helper.
    expect(app).toContain('Fresh rerun evidence · playback of the completed rerun');
    expect(app).toContain('applyDefaultFindingSelection(');
  });

  it('offers the supported inventory adapter as executable', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('Executable synthetic inventory reservation');
    const option = html.match(/<option\b[^>]*value=["']inventory-reservation["'][^>]*>/)?.[0];
    expect(option).toBeDefined();
    expect(option).not.toMatch(/\bdisabled\b/);
  });

  it('does not reveal planted fault classes in target choices', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const choices = html.match(/<select\b[^>]*id=["']target-select["'][^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(choices).toBeDefined();
    expect(choices).not.toMatch(/Idempotency|Redelivery|Fill Race/i);
  });
});
