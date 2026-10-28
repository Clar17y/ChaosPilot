import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SourceBundle, TargetVariant } from '../domain.ts';

function read(variant: TargetVariant): SourceBundle {
  if (variant !== 'clean' && variant !== 'inventory-candidate-a') throw new Error(`Unsupported inventory variant: ${variant}`);
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const folder = variant === 'clean' ? 'clean' : 'candidate-a';
  const content = readFileSync(new URL(`./variants/${folder}/service.${ext}`, import.meta.url), 'utf8');
  const files = [{ path: `service.${ext}`, content }];
  const hash = createHash('sha256').update(files[0]!.path + '\0' + content.replace(/\r\n/g, '\n') + '\0').digest('hex');
  return { hash, files };
}
const loaded = new Map<TargetVariant, SourceBundle>(['clean', 'inventory-candidate-a'].map(v => [v as TargetVariant, read(v as TargetVariant)]));
export function getSourceBundle(variant: TargetVariant): SourceBundle {
  const original = loaded.get(variant);
  if (!original) throw new Error(`Unsupported inventory variant: ${variant}`);
  const current = read(variant);
  if (current.hash !== original.hash || current.files[0]!.content !== original.files[0]!.content) throw new Error('Inventory runtime source changed; restart required');
  return structuredClone(original);
}
