import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import { assertAdapterContract, assertAdapterVariant, resolveAdapter } from '../adapters/index.ts';
import { isObservation, validatePinnedContext } from './validation.ts';
import { CATALOG } from './catalog.ts';
import { digest, evaluatorIdentity, transportIdentity } from './identity.ts';
import { aggregate, evaluateJourney } from './evaluator.ts';
import { startTarget, commandPath, type TargetOptions } from './target.ts';
import { requestJson } from './client.ts';
import type { ApiJourneyRecord, JourneyEvidence, Observation } from './types.ts';

export interface RunOptions { variant: TargetVariant; systemSnapshot: SystemBriefSnapshot; signal?: AbortSignal; timeoutMs?: number;
  /** Local tests only; not accepted by control routes or CLI. */
  targetOptions?: Omit<TargetOptions, 'variant'>;
}
export function assertContext(snapshot: SystemBriefSnapshot, variant: TargetVariant): void {
  validatePinnedContext(snapshot);
  assertAdapterVariant(snapshot.brief.adapterId, variant);
  assertAdapterContract(snapshot);
}
export function seal(record: ApiJourneyRecord): ApiJourneyRecord {
  record.integrity = digest({ ...record, integrity: '' }); return record;
}
export async function runApiJourneys(options: RunOptions): Promise<ApiJourneyRecord> {
  const { variant, signal } = options;
  const snapshot = structuredClone(options.systemSnapshot);
  assertContext(snapshot, variant);
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30_000) throw new Error('Invalid journey deadline');
  const sourceHash = resolveAdapter('synthetic-trading').getSourceBundle(variant).hash;
  const record: ApiJourneyRecord = { schemaVersion: 1, type: 'scripted-target-api', id: `apij_${randomUUID()}`, startedAt: new Date().toISOString(),
    finishedAt: '', adapterId: 'synthetic-trading', variant, systemSnapshot: snapshot, sourceHash, transport: transportIdentity(), evaluator: evaluatorIdentity(),
    contractHash: digest(snapshot.contract), status: 'inconclusive', journeys: [], integrity: '' };
  for (const definition of CATALOG) {
    const evidence: JourneyEvidence = { id: definition.id, instanceId: '', endpoint: '', exchanges: [], observation: null, assertions: [], status: 'inconclusive' };
    record.journeys.push(evidence);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('Observation horizon timed out')), timeout);
    let target: Awaited<ReturnType<typeof startTarget>> | undefined;
    try {
      controller.signal.throwIfAborted();
      target = await startTarget({ ...options.targetOptions, variant });
      evidence.instanceId = target.instanceId; evidence.endpoint = target.endpoint;
      const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
        const exchange = await requestJson(target!.endpoint, method, path, body, controller.signal);
        evidence.exchanges.push(exchange);
        if (exchange.status !== (method === 'POST' ? 202 : 200)) throw new Error(`Target HTTP ${exchange.status}`);
        const response = exchange.response as { instanceId?: string };
        if (response?.instanceId !== target!.instanceId) throw new Error('Target response identity mismatch');
        return exchange.response;
      };
      let count = 0;
      for (const checkpoint of definition.checkpoints) {
        // Post both identical execution requests before observing reconciliation.
        for (const command of checkpoint.commands) { await request('POST', commandPath(command), command); count++; }
        while (true) {
          const o = await request('GET', '/events') as Observation;
          if (!Number.isSafeInteger(o.processed) || !Number.isSafeInteger(o.queued) || !Array.isArray(o.events)) throw new Error('Malformed target observation');
          if (o.processed === count && o.queued === 0) break;
          if (o.processed > count || o.events.some(e => e.status === 'error')) throw new Error('Invalid target processing horizon');
          await pause(3, undefined, { signal: controller.signal });
        }
        const observed = await request('GET', '/state');
        if (!isObservation(observed)) throw new Error('Malformed target state observation');
        evidence.observation = observed;
        for (const key of Object.keys(checkpoint.expected.orders)) await request('GET', `/orders/${key}`);
      }
    } catch (error) {
      evidence.error = String(error);
      evidence.status = signal?.aborted ? 'cancelled' : 'inconclusive';
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await target?.close();
    }
    Object.assign(evidence, evaluateJourney(evidence, sourceHash, snapshot));
    // Preserve completed work; subsequent aborted catalog entries become explicit cancellations.
    // Completion wins if cancellation arrives only while closing the final completed journey.
  }
  record.status = aggregate(record.journeys.map(j => j.status));
  record.finishedAt = new Date().toISOString();
  return seal(record);
}
