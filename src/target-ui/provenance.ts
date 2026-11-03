import { readFileSync } from 'node:fs';
import type { SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import { resolveAdapter } from '../adapters/index.ts';
import { SEEDED_TRADING_BRIEF } from '../systems/index.ts';
import { createSystemSnapshot } from '../storage.ts';
import { assertContext } from '../target-api/runner.ts';
import { digest } from '../target-api/identity.ts';
import type { TargetUiProvenance } from './types.ts';

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const files = (paths: string[]) => digest(paths.map(p => readFileSync(new URL(p + extension, import.meta.url), 'utf8').replace(/\r\n/g, '\n')));
const uiHash = files(['../web/target-ui', './freshness', './validation', './types']);
const evaluatorHash = files(['./evaluator', './validation', './types']);
export function createUiProvenance(snapshot: SystemBriefSnapshot, variant: TargetVariant): TargetUiProvenance {
  assertContext(snapshot, variant);
  return { systemSnapshot: structuredClone(snapshot), sourceHash: resolveAdapter('synthetic-trading').getSourceBundle(variant).hash,
    contractHash: digest(snapshot.contract), uiHash, evaluatorHash };
}

/** Explicit seeded snapshot for the standalone CLI journey; always recorded in evidence. */
export async function createSeededUiProvenance(variant: TargetVariant): Promise<TargetUiProvenance> {
  return createUiProvenance(await createSystemSnapshot(SEEDED_TRADING_BRIEF), variant);
}
