import type { Experiment, ExperimentResult, TargetVariant, TraceEntry, Violation } from '../domain.ts';
import { InventoryService as Clean } from './variants/clean/service.ts';
import { InventoryService as Candidate } from './variants/candidate-a/service.ts';
import { InventoryOracle } from './oracle.ts';
import { getSourceBundle } from './bundle.ts';
import { parseExperiment } from './parser.ts';
import { LIMITS } from './contract.ts';
export { getContract } from './contract.ts';
export { getSourceBundle, parseExperiment };

interface Message { id: string; channel: string; payload: unknown; due: number; delivered: boolean; sequence: number }

export function executeExperiment(input: Experiment, variant: TargetVariant): ExperimentResult {
  const source = getSourceBundle(variant);
  const experiment = parseExperiment(input);
  const target = variant === 'clean' ? new Clean() : new Candidate();
  const oracle = new InventoryOracle();
  const messages = new Map<string, Message>();
  const trace: TraceEntry[] = [];
  const violations: Violation[] = [];
  const rejections: ExperimentResult['rejections'] = [];
  let time = 0;
  let valid = true;
  function enqueue(id: string, channel: string, payload: unknown, delay: number) {
    if (messages.has(id)) throw new Error('Message id already exists');
    if (messages.size >= LIMITS.maxMessages || time + delay > LIMITS.maxTicks) throw new Error('Message/time bound exceeded');
    messages.set(id, { id, channel, payload: structuredClone(payload), due: time + delay, delivered: false, sequence: messages.size });
  }
  function deliver(m: Message | undefined, step: number) {
    if (!m || m.delivered || m.due > time) throw new Error('Message missing, already delivered or not due');
    m.delivered = true;
    const outcome = target.receive(m.channel, m.payload);
    const state = target.snapshot();
    violations.push(...oracle.check(m.channel, m.payload, state, outcome, step));
    if (outcome === 'rejected') rejections.push({ step, reason: `Target rejected payload: ${m.id}` });
    trace.push({ step, time, action: 'deliver', messageId: m.id, payload: structuredClone(m.payload), outcome, state: { target: state } });
  }
  for (const [index, action] of experiment.steps.entries()) {
    const step = index + 1;
    try {
      switch (action.op) {
        case 'send': enqueue(action.id, action.to, action.payload, action.delay ?? 0); break;
        case 'duplicate': {
          const old = messages.get(action.messageId);
          if (!old) throw new Error('Cannot duplicate unknown message');
          enqueue(action.id, old.channel, old.payload, action.delay ?? 0);
          break;
        }
        case 'deliver': deliver(messages.get(action.messageId), step); break;
        case 'advance':
          if (time + action.ticks > LIMITS.maxTicks) throw new Error('Time bound exceeded');
          time += action.ticks; break;
        case 'drain': {
          const pending = [...messages.values()].filter(m => !m.delivered).sort((a, b) => a.due - b.due || a.sequence - b.sequence);
          for (const m of pending) { time = Math.max(time, m.due); deliver(m, step); }
          break;
        }
        default: throw new Error('Unsupported inventory action');
      }
      if (action.op !== 'deliver') trace.push({ step, time, action: action.op, outcome: 'executed', state: { target: target.snapshot() } });
    } catch (error) {
      valid = false;
      rejections.push({ step, reason: `Invalid harness action: ${error instanceof Error ? error.message : String(error)}` });
      break;
    }
  }
  return { schemaVersion: 1, experiment, sourceHash: source.hash, trace, snapshot: { target: target.snapshot(), logicalTime: time, messages: [...messages.values()] }, violations, rejections, valid };
}
