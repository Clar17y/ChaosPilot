import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_TARGET_VARIANTS, type SourceBundle, type TargetVariant } from '../domain.ts';

const VARIANT_FILES: Partial<Record<TargetVariant, string>> = {
  clean: 'clean',
  'recovery-candidate-a': 'candidate',
};

const SHARED_TRADING_MODULES = ['credit-manager', 'decoder', 'order-engine'] as const;

export function computeRecoverySourceHash(files: { path: string; content: string }[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content.replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readRecoverySourceBundle(variant: TargetVariant): SourceBundle {
  const variantFile = VARIANT_FILES[variant];
  if (!variantFile) {
    throw new Error(`Unsupported recovery variant: ${variant}`);
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const isCompiled = currentFilePath.endsWith('.js') || currentFilePath.endsWith('.mjs');
  const ext = isCompiled ? '.js' : '.ts';

  const entries: { bundlePath: string; diskPath: string }[] = [
    {
      bundlePath: `recovery-component${ext}`,
      diskPath: path.join(currentDir, 'variants', `${variantFile}${ext}`),
    },
    {
      bundlePath: `inbox${ext}`,
      diskPath: path.join(currentDir, `inbox${ext}`),
    },
    ...SHARED_TRADING_MODULES.map((mod) => ({
      bundlePath: `${mod}${ext}`,
      diskPath: path.join(currentDir, '..', 'simulator', 'variants', 'clean', `${mod}${ext}`),
    })),
  ];

  const files = entries.map(({ bundlePath, diskPath }) => {
    if (!fs.existsSync(diskPath)) {
      throw new Error(`Unable to load recovery source bundle file for variant ${variant}: ${diskPath}`);
    }
    const content = fs.readFileSync(diskPath, 'utf8');
    return {
      path: bundlePath,
      content,
    };
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  const hash = computeRecoverySourceHash(files);
  return { hash, files };
}

const loadedBundles = new Map<TargetVariant, SourceBundle>(
  RECOVERY_TARGET_VARIANTS.map((variant) => [variant, readRecoverySourceBundle(variant)]),
);

export function getSourceBundle(variant: TargetVariant): SourceBundle {
  const loaded = loadedBundles.get(variant);
  if (!loaded) {
    throw new Error(`Unsupported recovery variant: ${variant}`);
  }
  let current: SourceBundle;
  try {
    current = readRecoverySourceBundle(variant);
  } catch (error) {
    throw new Error('Recovery runtime source changed or is missing; restart required before continuing.', { cause: error });
  }
  if (current.hash !== loaded.hash || JSON.stringify(current.files) !== JSON.stringify(loaded.files)) {
    throw new Error('Recovery runtime source changed on disk; restart required before continuing.');
  }
  return structuredClone(loaded);
}
