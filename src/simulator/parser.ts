import type { Action, Channel, Experiment } from '../domain.ts';
import { MAX_TICKS } from './contract.ts';

const VALID_CHANNELS: readonly Channel[] = ['market', 'credit', 'client', 'reports'];

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function parseNonEmptyString(val: unknown, fieldName: string, stepIdx?: number): string {
  const prefix = stepIdx !== undefined ? `Step ${stepIdx}: ` : '';
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`${prefix}Field '${fieldName}' must be a non-empty string`);
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
      const id = parseNonEmptyString(step['id'], 'id', index);
      const to = step['to'];
      if (typeof to !== 'string' || !(VALID_CHANNELS as readonly string[]).includes(to)) {
        throw new Error(
          `Step ${index}: 'to' must be one of: ${VALID_CHANNELS.join(', ')}`,
        );
      }
      if (!('payload' in step)) {
        throw new Error(`Step ${index}: 'send' action requires a 'payload' field`);
      }
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'send',
        id,
        to: to as Channel,
        payload: step['payload'],
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    case 'duplicate': {
      const messageId = parseNonEmptyString(step['messageId'], 'messageId', index);
      const id = parseNonEmptyString(step['id'], 'id', index);
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'duplicate',
        messageId,
        id,
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    case 'deliver': {
      const messageId = parseNonEmptyString(step['messageId'], 'messageId', index);
      return {
        op: 'deliver',
        messageId,
      };
    }

    case 'advance': {
      const ticks = step['ticks'];
      if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks <= 0 || ticks > MAX_TICKS) {
        throw new Error(`Step ${index}: 'ticks' must be an integer from 1 to ${MAX_TICKS}`);
      }
      return {
        op: 'advance',
        ticks,
      };
    }

    case 'drain': {
      return { op: 'drain' };
    }

    case 'fill': {
      const messageId = parseNonEmptyString(step['messageId'], 'messageId', index);
      const orderId = parseNonEmptyString(step['orderId'], 'orderId', index);
      const executionId = parseNonEmptyString(step['executionId'], 'executionId', index);
      const quantity = step['quantity'];
      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error(`Step ${index}: 'quantity' must be a positive safe integer`);
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

    case 'confirm_cancel': {
      const messageId = parseNonEmptyString(step['messageId'], 'messageId', index);
      const orderId = parseNonEmptyString(step['orderId'], 'orderId', index);
      const delay = parseOptionalDelay(step['delay'], index);
      return {
        op: 'confirm_cancel',
        messageId,
        orderId,
        ...(delay !== undefined ? { delay } : {}),
      };
    }

    default:
      throw new Error(`Step ${index}: Unknown action operation '${op}'`);
  }
}

export function parseExperiment(input: unknown): Experiment {
  if (!isObject(input)) {
    throw new Error('Experiment input must be an object');
  }

  const hypothesis = parseNonEmptyString(input['hypothesis'], 'hypothesis');
  const expectedInvariant = parseNonEmptyString(input['expectedInvariant'], 'expectedInvariant');

  const rawSteps = input['steps'];
  if (!Array.isArray(rawSteps)) {
    throw new Error("Experiment 'steps' must be an array");
  }

  const steps = rawSteps.map((step, idx) => parseAction(step, idx));

  return {
    hypothesis,
    expectedInvariant,
    steps,
  };
}
