import {
  TARGET_VARIANTS, INVENTORY_TARGET_VARIANTS,
  type Experiment, type ExperimentResult, type SourceBundle,
  type SystemBriefSnapshot, type SystemContract, type TargetVariant,
} from '../domain.ts';
import * as trading from '../simulator/index.ts';
import * as inventory from '../inventory/index.ts';
import { canonicalJson } from '../evidence.ts';

/**
 * Minimum execution/evidence contract every registered adapter must supply.
 * An adapter is executable only when it is registered here with all of:
 * a pinned public contract, per-variant source bundles with stable hashes,
 * a strict experiment parser, and deterministic execution producing
 * trace/snapshot/violations/rejections evidence. Registration alone is not
 * enough to run from the UI: the adapter id must also be accepted by brief
 * validation (src/systems), have prompt identity (src/investigation/prompt.ts)
 * and provider context, and be listed as executable in src/web/workspace.ts.
 * Arbitrary external systems are not supported automatically.
 */
export interface AdapterRegistration {
  id: string;
  variants: readonly TargetVariant[];
  getContract(): SystemContract;
  getSourceBundle(variant: TargetVariant): SourceBundle;
  parseExperiment(input: unknown): Experiment;
  executeExperiment(experiment: Experiment, variant: TargetVariant): ExperimentResult;
}

const ADAPTER_REGISTRY: ReadonlyMap<string, AdapterRegistration> = new Map([
  ['synthetic-trading', {
    id: 'synthetic-trading',
    variants: TARGET_VARIANTS,
    getContract: trading.getContract,
    getSourceBundle: trading.getSourceBundle,
    parseExperiment: trading.parseExperiment,
    executeExperiment: trading.executeExperiment,
  }],
  ['inventory-reservation', {
    id: 'inventory-reservation',
    variants: INVENTORY_TARGET_VARIANTS,
    getContract: inventory.getContract,
    getSourceBundle: inventory.getSourceBundle,
    parseExperiment: inventory.parseExperiment,
    executeExperiment: inventory.executeExperiment,
  }],
]);

/** Adapter ids with a full server-side registration, in registration order. */
export function listRegisteredAdapters(): string[] {
  return [...ADAPTER_REGISTRY.keys()];
}

export function isRegisteredAdapter(adapterId: string | null | undefined): boolean {
  return typeof adapterId === 'string' && ADAPTER_REGISTRY.has(adapterId);
}

export function resolveAdapter(adapterId: string = 'synthetic-trading'): AdapterRegistration {
  const adapter = ADAPTER_REGISTRY.get(adapterId);
  if (!adapter) throw new Error(`Cannot execute ${adapterId === 'unconfigured' ? 'unconfigured adapter' : `unsupported adapter "${adapterId}"`}`);
  return adapter;
}
export function assertAdapterVariant(adapterId: string, variant: TargetVariant): void {
  if (!resolveAdapter(adapterId).variants.includes(variant)) throw new Error(`Unsupported variant "${variant}" for adapter "${adapterId}"`);
}
export function assertAdapterContract(snapshot: SystemBriefSnapshot): void {
  if (canonicalJson(snapshot.contract) !== canonicalJson(resolveAdapter(snapshot.brief.adapterId).getContract())) throw new Error('System brief contract does not match executing simulator contract');
}
