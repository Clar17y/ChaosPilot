import type { Action, Experiment } from '../domain.ts';
import { CHANNELS, LIMITS } from './contract.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function identifier(v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > 64 || v.trim() !== v) throw new Error('Action identifiers must be trimmed strings of 1..64 characters');
  return v;
}
function integer(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > LIMITS.maxTicks) throw new Error(`Action ticks/delay must be an integer in ${min}..${LIMITS.maxTicks}`);
  return v;
}
export function parseExperiment(input: unknown): Experiment {
  if (!object(input) || typeof input.hypothesis !== 'string' || !input.hypothesis.trim() || typeof input.expectedInvariant !== 'string' || !input.expectedInvariant.trim()) throw new Error('Experiment requires hypothesis and expectedInvariant');
  if (!Array.isArray(input.steps) || input.steps.length > LIMITS.maxActions) throw new Error('Experiment requires at most 100 actions');
  const steps: Action[] = input.steps.map((s: unknown) => {
    if (!object(s)) throw new Error('Action must be an object');
    switch (s.op) {
      case 'send': {
        if (!(CHANNELS as readonly unknown[]).includes(s.to)) throw new Error('Inventory send channel must be stock, reservations or shipments');
        if (!Object.hasOwn(s, 'payload')) throw new Error('send requires payload');
        return { op: 'send', id: identifier(s.id), to: s.to as typeof CHANNELS[number], payload: structuredClone(s.payload), delay: integer(s.delay ?? 0) };
      }
      case 'duplicate': return { op: 'duplicate', messageId: identifier(s.messageId), id: identifier(s.id), delay: integer(s.delay ?? 0) };
      case 'deliver': return { op: 'deliver', messageId: identifier(s.messageId) };
      case 'advance': return { op: 'advance', ticks: integer(s.ticks, 1) };
      case 'drain': return { op: 'drain' };
      default: throw new Error(`Unsupported inventory action: ${String(s.op)}`);
    }
  });
  return { hypothesis: input.hypothesis, expectedInvariant: input.expectedInvariant, steps };
}
