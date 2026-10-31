import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { InvestigationRecord } from '../src/domain.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { SEEDED_INVENTORY_BRIEF, SEEDED_TRADING_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { ChaosPilotServer } from '../src/server.ts';
import type { ExplanationTransport } from '../src/explanations/index.ts';
import { resolveExperimentPositionForIndex } from '../src/experiment-identity.ts';

export const usage = { inputTokens: 12, outputTokens: 10, estimatedCostUsd: 0.01 };
export async function challengeFixture(inventory = false): Promise<InvestigationRecord> {
  const systemBrief = await createSystemSnapshot(structuredClone(inventory ? SEEDED_INVENTORY_BRIEF : SEEDED_TRADING_BRIEF));
  const record = await runInvestigation({ variant: inventory ? 'inventory-candidate-a' : 'candidate-a', systemBrief, provider: new MockProvider() });
  if (!record.findings.length) throw new Error('Fixture must be an actual confirmed deterministic finding');
  return record;
}
export function originalExperiment(record: InvestigationRecord) {
  return record.experiments[resolveExperimentPositionForIndex(record.experiments, record.findings[0]!.experimentIndex)]!.experiment;
}
export function proposalFor(record: InvestigationRecord, count = 1): string {
  return JSON.stringify({ variants: Array.from({ length: count }, (_, i) => ({
    proposedChange: `Wait ${i + 1} additional ticks after the original sequence`,
    experiment: { ...originalExperiment(record), hypothesis: `challenge-variant-${i + 1}`, expectedInvariant: record.findings[0]!.violation.invariant, steps: [...originalExperiment(record).steps, { op: 'advance', ticks: i + 1 }] },
  })) });
}
export function fakeTransport(record: InvestigationRecord, count = 1) {
  const calls: string[] = [];
  const transport: ExplanationTransport = { generate: async (system, user) => {
    calls.push(system); JSON.parse(user);
    return { content: calls.length % 2 ? proposalFor(record, count) : JSON.stringify({ interpretation: '<script>Interpretation only</script>' }), usage, model: 'fake-muse' };
  } };
  return { transport, calls };
}
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
export async function tempChallengeDir(): Promise<string> { return fs.mkdtemp(path.join(process.cwd(), '.tmp-challenge-')); }

export interface TestResponse { status: number; json: any; text: string }
/** Exercise the actual HTTP handler (including same-origin checks) with controlled disconnects. */
export async function api(instance: ChaosPilotServer, method: string, url: string, body?: unknown, close?: EventEmitter, headers: Record<string, string> = {}): Promise<TestResponse> {
  const server = instance.createHttpServer();
  return new Promise(resolve => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: false,
      writeHead(status: number) { this.statusCode = status; return this; },
      end(text = '') { this.writableEnded = true; let json: unknown; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: this.statusCode, json, text }); },
    });
    close?.on('close', () => res.emit('close'));
    const req = {
      method, url, headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'content-type': 'application/json', ...headers }, socket: { localPort: 4310 }, resume() {},
      on(event: string, cb: (...args: any[]) => void) {
        if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(JSON.stringify(body))));
        if (event === 'end') queueMicrotask(() => cb());
        return this;
      },
    };
    server.emit('request', req as never, res as never);
  });
}
