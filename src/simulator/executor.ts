import type {
  Experiment,
  ExperimentResult,
  TargetVariant,
  TraceEntry,
  Violation,
} from '../domain.ts';
import { getSourceBundle } from './bundle.ts';
import { Oracle } from './oracle.ts';
import { Scheduler } from './scheduler.ts';
import type { ProcessResult, TargetEngineInterface, VenueOrder } from './types.ts';
import { TargetEngine as CandidateATarget } from './variants/candidate-a/order-engine.ts';
import { TargetEngine as CandidateBTarget } from './variants/candidate-b/order-engine.ts';
import { TargetEngine as CandidateCTarget } from './variants/candidate-c/order-engine.ts';
import { TargetEngine as CleanTarget } from './variants/clean/order-engine.ts';
import { Venue } from './venue.ts';

function createTargetEngine(variant: TargetVariant): TargetEngineInterface {
  switch (variant) {
    case 'clean':
      return new CleanTarget();
    case 'candidate-a':
      return new CandidateATarget();
    case 'candidate-b':
      return new CandidateBTarget();
    case 'candidate-c':
      return new CandidateCTarget();
    default:
      throw new Error(`Unknown target variant: ${variant}`);
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
  experiment: Experiment,
  variant: TargetVariant,
): ExperimentResult {
  const sourceBundle = getSourceBundle(variant);
  const target = createTargetEngine(variant);
  const venue = new Venue();
  const scheduler = new Scheduler();
  const oracle = new Oracle();

  const trace: TraceEntry[] = [];
  const rejections: { step: number; reason: string }[] = [];

  for (let stepIndex = 0; stepIndex < experiment.steps.length; stepIndex++) {
    const action = experiment.steps[stepIndex];
    if (!action) continue;

    switch (action.op) {
      case 'send': {
        const scheduleRes = scheduler.schedule(
          action.id,
          action.to,
          action.payload,
          action.delay,
        );
        const bTime = extractBusinessTime(action.payload);
        if (!scheduleRes.success) {
          rejections.push({ step: stepIndex, reason: scheduleRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'send',
            messageId: action.id,
            ...(bTime !== undefined ? { businessTime: bTime } : {}),
            payload: action.payload,
            outcome: `rejected: ${scheduleRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        } else {
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'send',
            messageId: action.id,
            ...(bTime !== undefined ? { businessTime: bTime } : {}),
            payload: action.payload,
            outcome: 'scheduled',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        }
        break;
      }

      case 'duplicate': {
        const dupRes = scheduler.duplicate(action.messageId, action.id, action.delay);
        const originalEnv = scheduler.getEnvelope(action.messageId);
        const bTime = originalEnv ? extractBusinessTime(originalEnv.payload) : undefined;
        if (!dupRes.success) {
          rejections.push({ step: stepIndex, reason: dupRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'duplicate',
            messageId: action.id,
            ...(bTime !== undefined ? { businessTime: bTime } : {}),
            outcome: `rejected: ${dupRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        } else {
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'duplicate',
            messageId: action.id,
            ...(bTime !== undefined ? { businessTime: bTime } : {}),
            outcome: `duplicated from ${action.messageId}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        }
        break;
      }

      case 'advance': {
        try {
          scheduler.advance(action.ticks);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Invalid logical clock advance';
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex, time: scheduler.getTime(), action: 'advance', outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }
        trace.push({
          step: stepIndex,
          time: scheduler.getTime(),
          action: 'advance',
          outcome: `advanced by ${action.ticks} ticks`,
          state: target.getSnapshot() as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'deliver': {
        const env = scheduler.getEnvelope(action.messageId);
        if (!env) {
          const reason = `Message '${action.messageId}' not found in scheduler`;
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'deliver',
            messageId: action.messageId,
            outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        if (env.delivered) {
          const reason = `Message '${action.messageId}' has already been delivered`;
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'deliver',
            messageId: action.messageId,
            outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        if (env.dueTime > scheduler.getTime()) {
          const reason = `Message '${action.messageId}' is not due yet (current: ${scheduler.getTime()}, due: ${env.dueTime})`;
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'deliver',
            messageId: action.messageId,
            outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        scheduler.markDelivered(env.id);
        const prevSnapshot = target.getSnapshot();

        let processResult: ProcessResult;
        try {
          processResult = target.processMessage(env.to, env.payload);
        } catch (err) {
          processResult = {
            accepted: false,
            reason: `Target exception: ${err instanceof Error ? err.message : String(err)}`,
          };
          oracle.recordTargetFailure(
            stepIndex,
            `Target decoder threw unhandled exception: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (processResult.accepted) {
          if (processResult.orderCreated) {
            venue.registerOrder(
              processResult.orderCreated.orderId,
              processResult.orderCreated.quantity,
              processResult.orderCreated.price,
            );
          }
        }

        const currSnapshot = target.getSnapshot();
        oracle.evaluateTransition({
          step: stepIndex,
          targetSnapshot: currSnapshot,
          previousSnapshot: prevSnapshot,
          venueOrders: venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
          action: 'deliver',
          channel: env.to,
          payload: env.payload,
          processResult,
        });

        const bTime = extractBusinessTime(env.payload);
        trace.push({
          step: stepIndex,
          time: scheduler.getTime(),
          action: 'deliver',
          messageId: env.id,
          ...(bTime !== undefined ? { businessTime: bTime } : {}),
          payload: env.payload,
          outcome: processResult.accepted
            ? 'delivered:processed'
            : `delivered:rejected (${processResult.reason})`,
          state: currSnapshot as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'drain': {
        let drainedCount = 0;
        while (true) {
          const env = scheduler.getNextUndeliveredEnvelope();
          if (!env) break;

          if (env.dueTime > scheduler.getTime()) {
            scheduler.setTime(env.dueTime);
          }
          scheduler.markDelivered(env.id);
          drainedCount++;

          const prevSnapshot = target.getSnapshot();
          let processResult: ProcessResult;
          try {
            processResult = target.processMessage(env.to, env.payload);
          } catch (err) {
            processResult = {
              accepted: false,
              reason: `Target exception: ${err instanceof Error ? err.message : String(err)}`,
            };
            oracle.recordTargetFailure(
              stepIndex,
              `Target decoder threw unhandled exception: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (processResult.accepted) {
            if (processResult.orderCreated) {
              venue.registerOrder(
                processResult.orderCreated.orderId,
                processResult.orderCreated.quantity,
                processResult.orderCreated.price,
              );
            }
          }

          const currSnapshot = target.getSnapshot();
          oracle.evaluateTransition({
            step: stepIndex,
            targetSnapshot: currSnapshot,
            previousSnapshot: prevSnapshot,
            venueOrders: venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
            action: 'drain:deliver',
            channel: env.to,
            payload: env.payload,
            processResult,
          });

          const bTime = extractBusinessTime(env.payload);
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'drain:deliver',
            messageId: env.id,
            ...(bTime !== undefined ? { businessTime: bTime } : {}),
            payload: env.payload,
            outcome: processResult.accepted
              ? 'delivered:processed'
              : `delivered:rejected (${processResult.reason})`,
            state: currSnapshot as unknown as Record<string, unknown>,
          });
        }

        if (drainedCount === 0) {
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'drain',
            outcome: 'drained:empty',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        }
        break;
      }

      case 'fill': {
        if (scheduler.getEnvelope(action.messageId)) {
          const reason = `Envelope id '${action.messageId}' already exists in scheduler`;
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'fill',
            messageId: action.messageId,
            outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        const venueRes = venue.recordFill(
          action.orderId,
          action.executionId,
          action.quantity,
          scheduler.getTime(),
        );

        if (!venueRes.success) {
          rejections.push({ step: stepIndex, reason: venueRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'fill',
            messageId: action.messageId,
            outcome: `rejected: ${venueRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        const reportPayload = {
          type: 'execution',
          id: action.messageId,
          orderId: action.orderId,
          executionId: action.executionId,
          quantity: action.quantity,
          price: venueRes.price!,
          occurredAt: venueRes.fact!.occurredAt,
        };

        const schedRes = scheduler.schedule(
          action.messageId,
          'reports',
          reportPayload,
          action.delay,
        );

        if (!schedRes.success) {
          rejections.push({ step: stepIndex, reason: schedRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'fill',
            messageId: action.messageId,
            outcome: `rejected: ${schedRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        } else {
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'fill',
            messageId: action.messageId,
            businessTime: venueRes.fact!.occurredAt,
            payload: reportPayload,
            outcome: 'venue_fill_scheduled',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          oracle.evaluateTransition({
            step: stepIndex,
            targetSnapshot: target.getSnapshot(),
            venueOrders: venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
            action: 'fill',
          });
        }
        break;
      }

      case 'confirm_cancel': {
        if (scheduler.getEnvelope(action.messageId)) {
          const reason = `Envelope id '${action.messageId}' already exists in scheduler`;
          rejections.push({ step: stepIndex, reason });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'confirm_cancel',
            messageId: action.messageId,
            outcome: `rejected: ${reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        const venueRes = venue.recordCancel(action.orderId, scheduler.getTime());
        if (!venueRes.success) {
          rejections.push({ step: stepIndex, reason: venueRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'confirm_cancel',
            messageId: action.messageId,
            outcome: `rejected: ${venueRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          break;
        }

        const reportPayload = {
          type: 'cancel_ack',
          id: action.messageId,
          orderId: action.orderId,
          cancelledQuantity: venueRes.fact!.cancelledQuantity,
          occurredAt: venueRes.fact!.occurredAt,
        };

        const schedRes = scheduler.schedule(
          action.messageId,
          'reports',
          reportPayload,
          action.delay,
        );

        if (!schedRes.success) {
          rejections.push({ step: stepIndex, reason: schedRes.reason! });
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'confirm_cancel',
            messageId: action.messageId,
            outcome: `rejected: ${schedRes.reason}`,
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
        } else {
          trace.push({
            step: stepIndex,
            time: scheduler.getTime(),
            action: 'confirm_cancel',
            messageId: action.messageId,
            businessTime: venueRes.fact!.occurredAt,
            payload: reportPayload,
            outcome: 'venue_cancel_scheduled',
            state: target.getSnapshot() as unknown as Record<string, unknown>,
          });
          oracle.evaluateTransition({
            step: stepIndex,
            targetSnapshot: target.getSnapshot(),
            venueOrders: venue.getSnapshot()['orders'] as Record<string, VenueOrder>,
            action: 'confirm_cancel',
          });
        }
        break;
      }
    }
  }

  const finalSnapshot = {
    target: target.getSnapshot(),
    venue: venue.getSnapshot(),
    logicalTime: scheduler.getTime(),
  };

  const finalViolations: Violation[] = [...oracle.getViolations()];

  return {
    schemaVersion: 1,
    experiment,
    sourceHash: sourceBundle.hash,
    trace,
    snapshot: finalSnapshot as unknown as Record<string, unknown>,
    violations: finalViolations,
    rejections,
    valid: rejections.length === 0,
  };
}
