import type { Action, Channel, Experiment } from '../domain.ts';
import { MAX_TICKS, RECOVERY_CHANNELS, RECOVERY_LIMITS } from './contract.ts';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function parseIdentifier(val: unknown, fieldName: string, stepIdx?: number): string {
  const prefix = stepIdx !== undefined ? `Step ${stepIdx}: ` : '';
  if (typeof val !== 'string' || val.trim().length === 0 || val.trim() !== val || val.length > 64) {
    throw new Error(`${prefix}Field '${fieldName}' must be a trimmed non-empty string of at most 64 characters`);
  }
  return val;
}

function parseNonEmptyText(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`Field '${fieldName}' must be a non-empty string`);
  }
  return val;
}

function parseOptionalDelay(val: unknown, stepIdx: number): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0 || val > MAX_TICKS) {
    throw new Error(`Step ${stepIdx}: 'delay' must be an integer from 0 to ${MAX_TICKS}`);
  }
  return val;
}

function assertOnlyAllowedKeys(step: Record<string, unknown>, allowed: readonly string[], stepIdx: number, op: string): void {
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) {
      throw new Error(`Step ${stepIdx}: Unexpected field '${key}' on '${op}' action`);
    }
  }
}

function parseAction(step: unknown, index: number): Action {
  if (!isObject(step)) {
    throw new Error(`Step ${index} must be an action object`);
  }

  const op = step['op'];
  if (typeof op !== 'string') {
    throw new Error(`Step ${index}: Missing or invalid 'op'`);
  }

  switch (op) {
    case 'send': {
      assertOnlyAllowedKeys(step, ['op', 'id', 'to', 'payload', 'delay'], index, op);
      const id = parseIdentifier(step['id'], 'id', index);
      const to = step['to'];
      if (typeof to !== 'string' || !(RECOVERY_CHANNELS as readonly string[]).includes(to)) {
        throw new Error(`Step ${index}: 'to' must be one of: ${RECOVERY_CHANNELS.join(', ')}`);
      }
      if (!Object.hasOwn(step, 'payload')) {
        throw new Error(`Step ${index}: 'send' action requires a 'payload' field`);
      }
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'send',
        id,
        to: to as Channel,
        payload: structuredClone(step['payload']),
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    case 'duplicate': {
      assertOnlyAllowedKeys(step, ['op', 'messageId', 'id', 'delay'], index, op);
      const messageId = parseIdentifier(step['messageId'], 'messageId', index);
      const id = parseIdentifier(step['id'], 'id', index);
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'duplicate',
        messageId,
        id,
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    case 'deliver': {
      assertOnlyAllowedKeys(step, ['op', 'messageId'], index, op);
      const messageId = parseIdentifier(step['messageId'], 'messageId', index);
      return {
        op: 'deliver',
        messageId,
      };
    }

    case 'advance': {
      assertOnlyAllowedKeys(step, ['op', 'ticks'], index, op);
      const ticks = step['ticks'];
      if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 0 || ticks > MAX_TICKS) {
        throw new Error(`Step ${index}: 'ticks' must be an integer from 0 to ${MAX_TICKS}`);
      }
      return {
        op: 'advance',
        ticks,
      };
    }

    case 'drain': {
      assertOnlyAllowedKeys(step, ['op'], index, op);
      return { op: 'drain' };
    }

    case 'fill': {
      assertOnlyAllowedKeys(step, ['op', 'messageId', 'orderId', 'executionId', 'quantity', 'delay'], index, op);
      const messageId = parseIdentifier(step['messageId'], 'messageId', index);
      const orderId = parseIdentifier(step['orderId'], 'orderId', index);
      const executionId = parseIdentifier(step['executionId'], 'executionId', index);
      const quantity = step['quantity'];
      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > RECOVERY_LIMITS.maxQuantity) {
        throw new Error(`Step ${index}: 'quantity' must be an integer from 1 to ${RECOVERY_LIMITS.maxQuantity}`);
      }
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'fill',
        messageId,
        orderId,
        executionId,
        quantity,
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    case 'disconnect': {
      assertOnlyAllowedKeys(step, ['op'], index, op);
      return { op: 'disconnect' };
    }

    case 'reconnect': {
      assertOnlyAllowedKeys(step, ['op'], index, op);
      return { op: 'reconnect' };
    }

    case 'confirm_cancel':
      throw new Error(`Step ${index}: Operation 'confirm_cancel' is unsupported in synthetic-trading-recovery v1`);

    default:
      throw new Error(`Step ${index}: Unsupported recovery action operation '${op}'`);
  }
}

export function parseExperiment(input: unknown): Experiment {
  if (!isObject(input)) {
    throw new Error('Experiment input must be an object');
  }

  const hypothesis = parseNonEmptyText(input['hypothesis'], 'hypothesis');
  const expectedInvariant = parseNonEmptyText(input['expectedInvariant'], 'expectedInvariant');

  const rawSteps = input['steps'];
  if (!Array.isArray(rawSteps)) {
    throw new Error("Experiment 'steps' must be an array");
  }
  if (rawSteps.length > RECOVERY_LIMITS.maxActions) {
    throw new Error(`Experiment requires at most ${RECOVERY_LIMITS.maxActions} actions`);
  }

  const steps = rawSteps.map((step, idx) => parseAction(step, idx));

  return {
    hypothesis,
    expectedInvariant,
    steps,
  };
}
