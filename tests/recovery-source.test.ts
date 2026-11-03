import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getSourceBundle } from '../src/recovery/index.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixture: string | undefined;

afterEach(() => {
  if (fixture) {
    const target = path.resolve(fixture);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('chaospilot-recovery-source-')) {
      throw new Error('Refusing cleanup outside the named recovery-source fixture directory');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fixture = undefined;
});

// Minimal compiled tree the bundle loader actually reads or imports.
function makeCompiledFixture(): string {
  const dist = path.join(repoRoot, 'dist');
  expect(fs.existsSync(path.join(dist, 'recovery', 'bundle.js'))).toBe(true);
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chaospilot-recovery-source-'));
  const files = [
    'domain.js',
    path.join('recovery', 'bundle.js'),
    path.join('recovery', 'inbox.js'),
    path.join('recovery', 'business.js'),
    path.join('recovery', 'variants', 'clean.js'),
    path.join('recovery', 'variants', 'candidate.js'),
    path.join('simulator', 'variants', 'clean', 'credit-manager.js'),
    path.join('simulator', 'variants', 'clean', 'decoder.js'),
    path.join('simulator', 'variants', 'clean', 'order-engine.js'),
  ];
  for (const rel of files) {
    const dest = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dist, rel), dest);
  }
  fs.writeFileSync(
    path.join(fixture, 'probe.mjs'),
    `
import * as fs from 'node:fs';
const [bundleUrl, mode, businessPath] = process.argv.slice(2);
const { getSourceBundle } = await import(bundleUrl);
const first = getSourceBundle('clean');
console.log('HASH ' + first.hash);
console.log('FILES ' + first.files.map((f) => f.path).join(','));
if (mode === 'hot') {
  fs.writeFileSync(businessPath, "export { TargetEngine } from './other-engine.js';\\nexport { decodePayload } from '../simulator/variants/clean/decoder.js';\\n");
  try {
    getSourceBundle('clean');
    console.log('HOT accepted');
  } catch (error) {
    console.log('HOT rejected: ' + error.message);
  }
}
`,
  );
  return fixture;
}

function runProbe(root: string, mode = 'fresh') {
  const bundleUrl = pathToFileURL(path.join(root, 'recovery', 'bundle.js')).href;
  const businessPath = path.join(root, 'recovery', 'business.js');
  return spawnSync(process.execPath, [path.join(root, 'probe.mjs'), bundleUrl, mode, businessPath], { encoding: 'utf8' });
}

describe('recovery executing-source provenance covers the module-selection shim', () => {
  it('bundles the shim under a neutral path bound to the shared modules, with no selector path visible', () => {
    for (const variant of ['clean', 'recovery-candidate-a'] as const) {
      const bundle = getSourceBundle(variant);
      const shim = bundle.files.find((f) => f.path === 'business.ts');
      expect(shim?.content).toContain("export { TargetEngine } from './order-engine.ts';");
      expect(shim?.content).toContain("export { decodePayload } from './decoder.ts';");
      expect(shim?.content).not.toMatch(/variants\/|clean|candidate/i);
      const inbox = bundle.files.find((f) => f.path === 'inbox.ts');
      expect(inbox?.content).toContain("./business.ts");
    }
  });

  it('compiled fixture: fresh process loads the known binding deterministically', () => {
    const root = makeCompiledFixture();
    const first = runProbe(root);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('business.js');
    const second = runProbe(root);
    expect(second.stdout.match(/HASH (\w+)/)?.[1]).toBe(first.stdout.match(/HASH (\w+)/)?.[1]);
  });

  it('compiled fixture: a redirected binding is rejected on fresh import instead of keeping the claimed source identity', () => {
    const root = makeCompiledFixture();
    fs.writeFileSync(
      path.join(root, 'recovery', 'business.js'),
      "export { TargetEngine } from './other-engine.js';\nexport { decodePayload } from '../simulator/variants/clean/decoder.js';\n",
    );
    fs.writeFileSync(path.join(root, 'recovery', 'other-engine.js'), 'export class TargetEngine {}\n');
    const result = runProbe(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('HASH ');
    expect(result.stderr).toMatch(/Unsupported recovery business module-selection binding/);
  });

  it('compiled fixture: a hot binding edit after load is rejected rather than silently reusing the loaded identity', () => {
    const root = makeCompiledFixture();
    const result = runProbe(root, 'hot');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HASH ');
    expect(result.stdout).toMatch(/HOT rejected: .*restart required/);
    expect(result.stdout).not.toContain('HOT accepted');
  });
});
