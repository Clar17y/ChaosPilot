import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_VARIANTS, type SourceBundle, type TargetVariant } from '../domain.ts';

const MODULE_NAMES = ['credit-manager', 'decoder', 'order-engine'] as const;

export function computeSourceHash(files: { path: string; content: string }[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update('\0');
    // Normalize newlines to ensure deterministic hashes regardless of OS git settings
    hash.update(file.content.replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readSourceBundle(variant: TargetVariant): SourceBundle {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const isCompiled = currentFilePath.endsWith('.js') || currentFilePath.endsWith('.mjs');
  const ext = isCompiled ? '.js' : '.ts';

  const files = MODULE_NAMES.map((moduleName) => {
    const filename = `${moduleName}${ext}`;
    const filePath = path.join(currentDir, 'variants', variant, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Unable to load source bundle file for variant ${variant}: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      path: filename,
      content,
    };
  });

  const hash = computeSourceHash(files);
  return { hash, files };
}

// Evaluated during runtime import, before callers can request context or execute.
const loadedBundles = new Map<TargetVariant, SourceBundle>(
  TARGET_VARIANTS.map((variant) => [
    variant, readSourceBundle(variant),
  ]),
);

export function getSourceBundle(variant: TargetVariant): SourceBundle {
  const loaded = loadedBundles.get(variant);
  if (!loaded) throw new Error(`Unable to load source bundle file for variant ${variant}`);
  let current: SourceBundle;
  try {
    current = readSourceBundle(variant);
  } catch (error) {
    throw new Error('Runtime source changed or is missing; restart required before continuing.', { cause: error });
  }
  if (current.hash !== loaded.hash || JSON.stringify(current.files) !== JSON.stringify(loaded.files)) {
    throw new Error('Runtime source changed on disk; restart required before continuing.');
  }
  return { hash: loaded.hash, files: loaded.files.map((file) => ({ ...file })) };
}
