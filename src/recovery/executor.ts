import type {
  Channel,
  DeliveryObservation,
  Experiment,
  ExperimentResult,
  RecordedTraceAction,
  TargetVariant,
  Violation,
} from '../domain.ts';
import { observeDelivery } from '../simulator/delivery-observation.ts';
import type { Envelope, VenueOrder } from '../simulator/types.ts';
import { Venue } from '../simulator/venue.ts';
import { getSourceBundle } from './bundle.ts';
import { MAX_TICKS, RECOVERY_DEADLINE_TICKS, RECOVERY_LIMITS } from './contract.ts';
import { RecoveryOracle } from './oracle.ts';
import { parseExperiment } from './parser.ts';
import type { RecoveryProcessResult, RecoveryTarget } from './types.ts';
import { RecoveryComponent as CandidateRecoveryComponent } from './variants/candidate.ts';
import { RecoveryComponent as CleanRecoveryComponent } from './variants/clean.ts';

export function createRecoveryTarget(variant: TargetVariant): RecoveryTarget {
  switch (variant) {
    case 'clean':
      return new CleanRecoveryComponent();
    case 'recovery-candidate-a':
      return new CandidateRecoveryComponent();
    default:
      throw new Error(`Unsupported recovery variant: ${variant}`);
  }
}

function extractBusinessTime(payload: unknown): number | undefined {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const val = (payload as Record<string, unknown>)['occurredAt'];
    if (typeof val === 'number' && Number.isSafeInteger(val)) {
      return val;
    }
  }
  return undefined;
}

export function executeExperiment(
  input: Experiment,
  variant: TargetVariant,
  customTarget?: RecoveryTarget,
): ExperimentResult {
  const sourceBundle = getSourceBundle(variant);
  const target = customTarget ?? createRecoveryTarget(variant);
  const venue = new Venue();
  const oracle = new RecoveryOracle();

  const trace: ExperimentResult['trace'] = [];
  const rejections: { step: number; reason: string }[] = [];
  const deliveryObservations: DeliveryObservation[] = [];

  let experiment: Experiment;
  try {
    experiment = parseExperiment(input);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    rejections.push({ step: 0, reason });
    const finalSnapshot = target.getSnapshot();
    const recovery = oracle.finalize({
      horizonTick: 0,
      valid: false,
      executionComplete: false,
      finalTraceIndex: 0,
      finalSnapshot,
    });
    return {
      schemaVersion: 1,
      categoryAware: true,
      experiment: input,
      sourceHash: sourceBundle.hash,
      trace,
      snapshot: {
        target: finalSnapshot,
        venue: venue.getSnapshot(),
        logicalTime: 0,
      },
      violations: [...oracle.getViolations()],
      rejections,
      valid: false,
      deliveryObservations,
      executionComplete: false,
      recovery,
    };
  }

  let logicalTime = 0;
  let sequenceCounter = 0;
  const envelopes = new Map<string, Envelope>();
  let connected = true;
  let reconnectedAtTick: number | undefined;
  let valid = true;
  let executionComplete = true;

  function scheduleEnvelope(
    id: string,
    to: Channel,
    payload: unknown,
    delay = 0,
  ): { success: boolean; reason?: string; envelope?: Envelope } {
    if (envelopes.has(id)) {
      return { success: false, reason: `Envelope ID '${id}' already exists` };
    }
    if (envelopes.size >= RECOVERY_LIMITS.maxMessages) {
      return { success: false, reason: `Message count exceeds limit (${RECOVERY_LIMITS.maxMessages})` };
    }
    if (!Number.isSafeInteger(delay) || delay < 0 || logicalTime + delay > MAX_TICKS) {
      return { success: false, reason: `Scheduled time exceeds logical clock bounds (max ${MAX_TICKS} ticks)` };
    }
    const envelope: Envelope = {
      id,
      to,
      payload: structuredClone(payload),
      scheduledAt: logicalTime,
      dueTime: logicalTime + delay,
      sequence: ++sequenceCounter,
      delivered: false,
    };
    envelopes.set(id, envelope);
    return { success: true, envelope };
  }

  function getNextUndeliveredEnvelope(): Envelope | undefined {
    let next: Envelope | undefined;
    for (const env of envelopes.values()) {
      if (!env.delivered) {
        if (
          !next ||
          env.dueTime < next.dueTime ||
          (env.dueTime === next.dueTime && env.sequence < next.sequence)
        ) {
          next = env;
        }
      }
    }
    return next;
  }

  function runDueTargetWorkAt(tick: number, stepIndex: number): void {
    let guard = 0;
    while (target.nextDueTick() !== undefined && target.nextDueTick()! <= tick) {
      if (++guard > 32) break;
      const prevSnapshot = target.getSnapshot();
      try {
        target.runDue(tick);
      } catch (err) {
        const msg = `Target recovery work threw unhandled exception: ${err instanceof Error ? err.message : String(err)}`;
        oracle.recordTargetFailure(stepIndex, msg);
        const currSnapshot = target.getSnapshot();
        trace.push({
          step: stepIndex,
          time: tick,
          action: 'reconcile',
          outcome: `exception: ${msg}`,
          state: currSnapshot as unknown as Record<string, unknown>,
        });
        break;
      }
      const currSnapshot = target.getSnapshot();
      trace.push({
        step: stepIndex,
        time: tick,
        action: 'reconcile',
        outcome: 'reconciled',
        state: currSnapshot as unknown as Record<string, unknown>,
      });
      oracle.onTargetWork(
        stepIndex,
        tick,
        trace.length - 1,
        prevSnapshot,
        currSnapshot,
        venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
      );
    }
  }

  function advanceClockTo(targetTick: number, stepIndex: number): void {
    runDueTargetWorkAt(logicalTime, stepIndex);
    while (logicalTime < targetTick) {
      const dueTick = target.nextDueTick();
      const nextDue = dueTick !== undefined && dueTick > logicalTime && dueTick <= targetTick ? dueTick : undefined;
      const nextDeadline = oracle.nextPendingDeadlineTick(logicalTime, targetTick);
      const nextTick = Math.min(nextDue ?? targetTick, nextDeadline ?? targetTick, targetTick);
      logicalTime = nextTick;
      runDueTargetWorkAt(logicalTime, stepIndex);
      if (logicalTime < targetTick) {
        // Keep a deadline-local observation after all target work due here.
        // A later advance/delivery trace cannot prove accounting at this tick.
        if (nextDeadline === logicalTime) {
          trace.push({ step: stepIndex, time: logicalTime, action: 'recovery:deadline',
            outcome: 'recovery deadline checked', state: target.getSnapshot() as unknown as Record<string, unknown> });
        }
        oracle.checkDeadlinesAt(stepIndex, logicalTime, Math.max(0, trace.length - 1), target.getSnapshot());
      }
    }
  }

  function deliverEnvelope(env: Envelope, stepIndex: number, actionLabel: 'deliver' | 'drain:deliver'): number {
    env.delivered = true;
    const prevSnapshot = target.getSnapshot();
    let processResult: RecoveryProcessResult;
    let targetException = false;
    try {
      processResult = target.processMessage(env.to, structuredClone(env.payload), logicalTime);
    } catch (err) {
      targetException = true;
      const msg = `Target threw unhandled exception: ${err instanceof Error ? err.message : String(err)}`;
      processResult = { accepted: false, reason: msg };
      oracle.recordTargetFailure(stepIndex, msg);
    }

    if (processResult.accepted && processResult.orderCreated) {
      venue.registerOrder(
        processResult.orderCreated.orderId,
        processResult.orderCreated.quantity,
        processResult.orderCreated.price,
      );
    }

    const currSnapshot = target.getSnapshot();
    deliveryObservations.push(
      observeDelivery(env, processResult, currSnapshot, trace, stepIndex, actionLabel, targetException),
    );

    const bTime = extractBusinessTime(env.payload);
    trace.push({
      step: stepIndex,
      time: logicalTime,
      action: actionLabel,
      messageId: env.id,
      ...(bTime !== undefined ? { businessTime: bTime } : {}),
      payload: structuredClone(env.payload),
      outcome: processResult.accepted
        ? processResult.duplicate
          ? 'delivered:duplicate'
          : 'delivered:processed'
        : `delivered:rejected (${processResult.reason})`,
      state: currSnapshot as unknown as Record<string, unknown>,
    });

    const deliverTraceIndex = trace.length - 1;
    oracle.evaluateDelivery({
      step: stepIndex,
      tick: logicalTime,
      traceIndex: deliverTraceIndex,
      messageId: env.id,
      channel: env.to,
      payload: env.payload,
      previousSnapshot: prevSnapshot,
      targetSnapshot: currSnapshot,
      processResult,
      targetException,
      executorConnected: connected,
      venueOrders: venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
    });

    return deliverTraceIndex;
  }

  function rejectHarnessAction(stepIndex: number, actionName: RecordedTraceAction, reason: string, messageId?: string): void {
    valid = false;
    executionComplete = false;
    rejections.push({ step: stepIndex, reason });
    trace.push({
      step: stepIndex,
      time: logicalTime,
      action: actionName,
      ...(messageId !== undefined ? { messageId } : {}),
      outcome: `rejected: ${reason}`,
      state: target.getSnapshot() as unknown as Record<string, unknown>,
    });
  }

  for (let stepIndex = 0; stepIndex < experiment.steps.length; stepIndex++) {
    const action = experiment.steps[stepIndex];
    if (!action) continue;

    switch (action.op) {
      case 'send': {
        const res = scheduleEnvelope(action.id, action.to, action.payload, action.delay ?? 0);
        if (!res.success) {
          rejectHarnessAction(stepIndex, 'send', res.reason!, action.id);
          break;
        }
        const bTime = extractBusinessTime(action.payload);
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'send',
          messageId: action.id,
          ...(bTime !== undefined ? { businessTime: bTime } : {}),
          payload: structuredClone(action.payload),
          outcome: 'scheduled',
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'duplicate': {
        const original = envelopes.get(action.messageId);
        if (!original) {
          rejectHarnessAction(stepIndex, 'duplicate', `Unknown messageId to duplicate: ${action.messageId}`, action.id);
          break;
        }
        const res = scheduleEnvelope(action.id, original.to, original.payload, action.delay ?? 0);
        if (!res.success) {
          rejectHarnessAction(stepIndex, 'duplicate', res.reason!, action.id);
          break;
        }
        const bTime = extractBusinessTime(original.payload);
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'duplicate',
          messageId: action.id,
          ...(bTime !== undefined ? { businessTime: bTime } : {}),
          outcome: `duplicated from ${action.messageId}`,
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'deliver': {
        const env = envelopes.get(action.messageId);
        if (!env) {
          rejectHarnessAction(stepIndex, 'deliver', `Message '${action.messageId}' not found in scheduler`, action.messageId);
          break;
        }
        if (env.delivered) {
          rejectHarnessAction(stepIndex, 'deliver', `Message '${action.messageId}' has already been delivered`, action.messageId);
          break;
        }
        if (env.dueTime > logicalTime) {
          rejectHarnessAction(
            stepIndex,
            'deliver',
            `Message '${action.messageId}' is not due yet (current: ${logicalTime}, due: ${env.dueTime})`,
            action.messageId,
          );
          break;
        }
        runDueTargetWorkAt(logicalTime, stepIndex);
        const traceIndex = deliverEnvelope(env, stepIndex, 'deliver');
        oracle.checkDeadlinesAt(stepIndex, logicalTime, traceIndex, target.getSnapshot());
        break;
      }

      case 'advance': {
        if (!Number.isSafeInteger(action.ticks) || action.ticks < 0 || logicalTime + action.ticks > MAX_TICKS) {
          rejectHarnessAction(
            stepIndex,
            'advance',
            `Advance by ${action.ticks} ticks from ${logicalTime} exceeds maxTicks (${MAX_TICKS})`,
          );
          break;
        }
        const targetTick = logicalTime + action.ticks;
        advanceClockTo(targetTick, stepIndex);
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'advance',
          outcome: `advanced by ${action.ticks} ticks`,
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        const advanceTraceIndex = trace.length - 1;
        oracle.checkDeadlinesAt(stepIndex, logicalTime, advanceTraceIndex, target.getSnapshot());
        break;
      }

      case 'drain': {
        let drainedCount = 0;
        while (true) {
          const env = getNextUndeliveredEnvelope();
          if (!env) break;

          if (env.dueTime > logicalTime) {
            advanceClockTo(env.dueTime, stepIndex);
          } else {
            runDueTargetWorkAt(logicalTime, stepIndex);
          }

          drainedCount++;
          const deliverTraceIndex = deliverEnvelope(env, stepIndex, 'drain:deliver');

          const nextEnv = getNextUndeliveredEnvelope();
          if (!nextEnv || nextEnv.dueTime > logicalTime) {
            oracle.checkDeadlinesAt(stepIndex, logicalTime, deliverTraceIndex, target.getSnapshot());
          }
        }

        if (drainedCount === 0) {
          trace.push({
            step: stepIndex,
            time: logicalTime,
            action: 'drain',
            outcome: 'drained:empty',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        }
        break;
      }

      case 'fill': {
        if (envelopes.has(action.messageId)) {
          rejectHarnessAction(stepIndex, 'fill', `Envelope id '${action.messageId}' already exists in scheduler`, action.messageId);
          break;
        }
        const venueRes = venue.recordFill(action.orderId, action.executionId, action.quantity, logicalTime);
        if (!venueRes.success) {
          rejectHarnessAction(stepIndex, 'fill', venueRes.reason!, action.messageId);
          break;
        }
        const reportPayload = {
          type: 'execution' as const,
          id: action.messageId,
          orderId: action.orderId,
          executionId: action.executionId,
          quantity: action.quantity,
          price: venueRes.price!,
          occurredAt: venueRes.fact!.occurredAt,
        };
        const schedRes = scheduleEnvelope(action.messageId, 'reports', reportPayload, action.delay ?? 0);
        if (!schedRes.success) {
          rejectHarnessAction(stepIndex, 'fill', schedRes.reason!, action.messageId);
          break;
        }
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'fill',
          messageId: action.messageId,
          businessTime: venueRes.fact!.occurredAt,
          payload: reportPayload,
          outcome: 'venue_fill_scheduled',
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        oracle.evaluateStateInvariants(
          stepIndex,
          undefined,
          target.getSnapshot(),
          venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
        );
        break;
      }

      case 'disconnect': {
        if (!connected) {
          trace.push({
            step: stepIndex,
            time: logicalTime,
            action: 'connection:disconnect',
            outcome: 'noop:already_disconnected',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }
        if (reconnectedAtTick !== undefined) {
          rejectHarnessAction(
            stepIndex,
            'connection:disconnect',
            'Invalid harness action: synthetic-trading-recovery v1 supports at most one outage/reconnect cycle per experiment',
          );
          break;
        }
        connected = false;
        target.setConnected(false, logicalTime);
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'connection:disconnect',
          outcome: 'disconnected',
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'reconnect': {
        if (connected) {
          trace.push({
            step: stepIndex,
            time: logicalTime,
            action: 'connection:reconnect',
            outcome: 'noop:already_connected',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }
        if (logicalTime + RECOVERY_DEADLINE_TICKS > MAX_TICKS) {
          rejectHarnessAction(
            stepIndex,
            'connection:reconnect',
            `Invalid harness action: reconnect at tick ${logicalTime} sets deadline tick ${logicalTime + RECOVERY_DEADLINE_TICKS} beyond maxTicks (${MAX_TICKS})`,
          );
          break;
        }
        connected = true;
        reconnectedAtTick = logicalTime;
        target.setConnected(true, logicalTime);
        const snap = target.getSnapshot();
        trace.push({
          step: stepIndex,
          time: logicalTime,
          action: 'connection:reconnect',
          outcome: 'reconnected',
          state: snap as unknown as Record<string, unknown>,
        });
        oracle.onReconnect(logicalTime, trace.length - 1, snap);
        break;
      }

      default: {
        rejectHarnessAction(stepIndex, 'unsupported', `Unsupported recovery action '${(action as { op: string }).op}'`);
        break;
      }
    }

    if (!valid) {
      break;
    }
  }

  const finalSnapshot = target.getSnapshot();
  const recovery = oracle.finalize({
    horizonTick: logicalTime,
    valid,
    executionComplete,
    finalTraceIndex: Math.max(0, trace.length - 1),
    finalSnapshot,
  });

  const finalViolations: Violation[] = [...oracle.getViolations()];

  return {
    schemaVersion: 1,
    categoryAware: true,
    experiment,
    sourceHash: sourceBundle.hash,
    trace,
    snapshot: {
      target: finalSnapshot,
      venue: venue.getSnapshot(),
      logicalTime,
    },
    violations: finalViolations,
    rejections,
    valid,
    deliveryObservations,
    executionComplete: recovery.executionComplete,
    recovery,
  };
}
