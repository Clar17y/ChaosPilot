import type { ExperimentResult, SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import type { TargetSnapshot } from '../simulator/types.ts';

export type Command =
  | { requestId: string; kind: 'setup'; limit: number }
  | { requestId: string; kind: 'order'; orderId: string; quantity: number }
  | { requestId: string; kind: 'execution'; orderId: string; executionId: string; quantity: number };
export type OrderView = TargetSnapshot['orders'][string] & { businessStatus: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' };
export interface Receipt { instanceId: string; receiptId: string; requestId: string; sequence: number; status: 'queued' }
export interface BusinessEvent {
  instanceId: string; eventId: string; receiptId: string; requestId: string; sequence: number;
  command: Command; status: 'accepted' | 'rejected' | 'error'; reason?: string;
  messageId: string; deliveryStep: number; result: ExperimentResult | null;
}
export interface Observation {
  instanceId: string; processed: number; queued: number; events: BusinessEvent[];
  state: TargetSnapshot; orders: Record<string, OrderView>;
}
export interface Exchange {
  method: 'GET' | 'POST'; path: string; request: unknown; status: number;
  response: unknown; elapsedMs: number;
}
export type Status = 'pass' | 'fail' | 'inconclusive' | 'cancelled';
export interface Assertion { id: string; expected: unknown; observed: unknown; status: 'pass' | 'fail' | 'inconclusive' }
export interface JourneyEvidence {
  id: string; instanceId: string; endpoint: string; exchanges: Exchange[];
  observation: Observation | null; error?: string; assertions: Assertion[]; status: Status;
}
export interface Identity { version: 1; hash: string }
export interface ApiJourneyRecord {
  schemaVersion: 1; type: 'scripted-target-api'; id: string; startedAt: string; finishedAt: string;
  adapterId: 'synthetic-trading'; variant: TargetVariant; systemSnapshot: SystemBriefSnapshot;
  sourceHash: string; transport: Identity; evaluator: Identity; contractHash: string;
  status: Status; journeys: JourneyEvidence[]; integrity: string;
}
export interface ApiJourneySummary {
  id: string;
  startedAt: string;
  finishedAt: string;
  adapterId: 'synthetic-trading';
  variant: TargetVariant;
  systemBrief: { id: string; name: string; revision: number };
  status: Status;
  journeyCount: number;
}

export interface Comparison {
  status: 'match' | 'different' | 'blocked';
  reasons: string[];
  note: string;
  originalId: string;
  freshId?: string;
  differences?: {
    journeyId: string;
    description: string;
    expected?: unknown;
    observed?: unknown;
  }[];
}
