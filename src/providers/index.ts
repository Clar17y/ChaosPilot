import type { ExperimentProvider, ProviderKind } from '../domain.ts';
import { MockProvider } from './mock.ts';
import { MetaProvider, type MetaProviderOptions } from './meta.ts';

export type ProviderOptions = MetaProviderOptions;

export function createProvider(kind: ProviderKind, options: ProviderOptions = {}): ExperimentProvider {
  switch (kind) {
    case 'mock':
      return new MockProvider(options);
    case 'meta':
      return new MetaProvider(options);
    default:
      throw new Error(`Unsupported provider kind: ${kind as string}`);
  }
}

export { MockProvider } from './mock.ts';
export { MetaProvider } from './meta.ts';
export {
  BudgetLedger,
  BudgetExceededError,
  CorruptedLedgerError,
  MODEL_PRICING,
  calculateCost,
  calculateWorstCaseCost
} from './budget.ts';
