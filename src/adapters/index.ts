import { TARGET_VARIANTS, INVENTORY_TARGET_VARIANTS, type SystemBriefSnapshot, type TargetVariant } from '../domain.ts';
import * as trading from '../simulator/index.ts';
import * as inventory from '../inventory/index.ts';
import { canonicalJson } from '../evidence.ts';

export function resolveAdapter(adapterId: string = 'synthetic-trading') {
  switch (adapterId) {
    case 'synthetic-trading': return { id: adapterId, variants: TARGET_VARIANTS as readonly TargetVariant[], ...trading };
    case 'inventory-reservation': return { id: adapterId, variants: INVENTORY_TARGET_VARIANTS as readonly TargetVariant[], ...inventory };
    default: throw new Error(`Cannot execute ${adapterId === 'unconfigured' ? 'unconfigured adapter' : `unsupported adapter "${adapterId}"`}`);
  }
}
export function assertAdapterVariant(adapterId: string, variant: TargetVariant): void {
  if (!resolveAdapter(adapterId).variants.includes(variant)) throw new Error(`Unsupported variant "${variant}" for adapter "${adapterId}"`);
}
export function assertAdapterContract(snapshot: SystemBriefSnapshot): void {
  if (canonicalJson(snapshot.contract) !== canonicalJson(resolveAdapter(snapshot.brief.adapterId).getContract())) throw new Error('System brief contract does not match executing simulator contract');
}
