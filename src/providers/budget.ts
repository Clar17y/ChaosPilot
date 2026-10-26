import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

// 2026-10-26 official prices from https://dev.meta.ai/docs/pricing-rate-limits
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'muse-wonder-1.0': { inputPer1M: 4.00, outputPer1M: 20.00 },
  'muse-spark-1.3': { inputPer1M: 1.25, outputPer1M: 4.25 }
};

export interface LedgerTransaction {
  id: string;
  timestamp: string;
  type: 'reserve' | 'commit' | 'retain_worst_case' | 'release';
  reservationId: string;
  model: string;
  amountUsd: number;
  reason?: string;
}

export interface BudgetLedgerData {
  schemaVersion: 1;
  totalBudgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  activeReservations: Record<string, { model: string; amountUsd: number; createdAt: string }>;
  transactions: LedgerTransaction[];
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class CorruptedLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptedLedgerError';
  }
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model] : undefined;
  if (!pricing) {
    throw new Error(`Unsupported model: ${model}. Available models: ${Object.keys(MODEL_PRICING).join(', ')}`);
  }

  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    throw new Error(`Invalid token counts: inputTokens=${inputTokens}, outputTokens=${outputTokens}. Must be bounded finite nonnegative safe integers.`);
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

export function calculateWorstCaseCost(model: string, maxPromptBytes: number, maxOutputTokens: number): number {
  if (
    typeof maxPromptBytes !== 'number' ||
    typeof maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(maxPromptBytes) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxPromptBytes < 0 ||
    maxOutputTokens < 0
  ) {
    throw new Error(`Invalid bounds: maxPromptBytes=${maxPromptBytes}, maxOutputTokens=${maxOutputTokens}. Must be bounded finite nonnegative safe integers.`);
  }
  // Conservative worst-case estimate: 1 byte = 1 token
  return calculateCost(model, maxPromptBytes, maxOutputTokens);
}

export class BudgetLedger {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly defaultBudget: number;
  private readonly configuredBudget: number | undefined;

  constructor(filePath?: string, defaultBudgetUsd?: number) {
    const configuredPath = filePath || process.env['CHAOSPILOT_BUDGET_LEDGER_PATH'] || path.join('runs', 'budget-ledger.json');
    this.filePath = path.resolve(configuredPath);
    this.lockPath = `${this.filePath}.lock`;

    let envBudget: number | undefined;
    const envBudgetStr = process.env['CHAOSPILOT_API_BUDGET_USD'];
    if (envBudgetStr !== undefined) {
      const parsed = Number(envBudgetStr);
      if (Number.isFinite(parsed) && parsed >= 0) {
        envBudget = parsed;
      } else {
        throw new Error(`Invalid CHAOSPILOT_API_BUDGET_USD environment value: "${envBudgetStr}". Must be a bounded finite nonnegative number.`);
      }
    }

    if (defaultBudgetUsd !== undefined) {
      if (typeof defaultBudgetUsd !== 'number' || !Number.isFinite(defaultBudgetUsd) || defaultBudgetUsd < 0) {
        throw new Error(`Invalid defaultBudgetUsd: ${defaultBudgetUsd}. Must be a bounded finite nonnegative number.`);
      }
      this.configuredBudget = defaultBudgetUsd;
    } else if (envBudget !== undefined) {
      this.configuredBudget = envBudget;
    }

    this.defaultBudget = this.configuredBudget ?? 25;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  private acquireLock(timeoutMs = 5000): void {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const t0 = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Age cannot prove another process stopped. Keep unknown ownership closed.
          if (Date.now() - t0 > timeoutMs) {
            throw new Error(`Ledger lock acquisition timed out after ${timeoutMs}ms for ${this.lockPath}`);
          }
          // Sleep 10ms synchronously before retrying
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } else {
          throw err;
        }
      }
    }
  }

  private releaseLock(): void {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (fs.existsSync(this.lockPath)) {
          fs.rmdirSync(this.lockPath);
        }
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  private load(): BudgetLedgerData {
    if (fs.existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } catch (err) {
        throw new CorruptedLedgerError(`Cannot read ledger file at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      let data: BudgetLedgerData;
      try {
        data = JSON.parse(raw) as BudgetLedgerData;
      } catch (err) {
        throw new CorruptedLedgerError(`Corrupted ledger file: invalid JSON in ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (
        !data ||
        typeof data !== 'object' ||
        data.schemaVersion !== 1 ||
        typeof data.totalBudgetUsd !== 'number' ||
        !Number.isFinite(data.totalBudgetUsd) ||
        data.totalBudgetUsd < 0 ||
        typeof data.spentUsd !== 'number' ||
        !Number.isFinite(data.spentUsd) ||
        data.spentUsd < 0 ||
        typeof data.reservedUsd !== 'number' ||
        !Number.isFinite(data.reservedUsd) ||
        data.reservedUsd < 0 ||
        typeof data.activeReservations !== 'object' ||
        data.activeReservations === null ||
        Array.isArray(data.activeReservations) ||
        !Array.isArray(data.transactions)
      ) {
        throw new CorruptedLedgerError(`Corrupted ledger file: schema validation failed for ${this.filePath}`);
      }

      // Validate active reservations
      let sumRes = 0;
      for (const [resId, res] of Object.entries(data.activeReservations)) {
        if (
          !res ||
          typeof res !== 'object' ||
          typeof res.model !== 'string' ||
          !Object.hasOwn(MODEL_PRICING, res.model) ||
          typeof res.amountUsd !== 'number' ||
          !Number.isFinite(res.amountUsd) ||
          res.amountUsd < 0 ||
          typeof res.createdAt !== 'string'
        ) {
          throw new CorruptedLedgerError(`Corrupted ledger reservation ${resId} in ${this.filePath}`);
        }
        sumRes += res.amountUsd;
      }

      if (Math.abs(sumRes - data.reservedUsd) > 1e-4) {
        throw new CorruptedLedgerError(`Corrupted ledger: activeReservations sum (${sumRes}) does not match reservedUsd (${data.reservedUsd}) in ${this.filePath}`);
      }

      // Avoid silently restoring a larger persisted cap after config is reduced
      if (this.configuredBudget !== undefined && this.configuredBudget < data.totalBudgetUsd) {
        data.totalBudgetUsd = this.configuredBudget;
        this.save(data);
      }

      return data;
    }

    return {
      schemaVersion: 1,
      totalBudgetUsd: this.defaultBudget,
      spentUsd: 0,
      reservedUsd: 0,
      activeReservations: {},
      transactions: []
    };
  }

  private save(data: BudgetLedgerData): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempFile = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempFile, serialized, 'utf-8');

    let renamed = false;
    let renameErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tempFile, this.filePath);
        renamed = true;
        break;
      } catch (err) {
        renameErr = err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }

    if (!renamed) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {}
      throw new Error(`Failed to atomically save ledger: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
    }
  }

  public reserve(amountUsd: number, model: string): string {
    if (!Object.hasOwn(MODEL_PRICING, model)) {
      throw new Error(`Unsupported model: ${model}`);
    }
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new Error(`Invalid reservation amount: ${amountUsd}`);
    }

    return this.withLock(() => {
      const data = this.load();
      const roundedAmount = Number(amountUsd.toFixed(6));
      const currentTotal = Number((data.spentUsd + data.reservedUsd).toFixed(6));

      if (currentTotal + roundedAmount > data.totalBudgetUsd + 1e-9) {
        throw new BudgetExceededError(
          `Budget exceeded: requested reservation $${roundedAmount.toFixed(4)}, current spent $${data.spentUsd.toFixed(4)}, ` +
          `reserved $${data.reservedUsd.toFixed(4)}, total limit $${data.totalBudgetUsd.toFixed(4)}. ` +
          `App-side budget does not control whole Meta account.`
        );
      }

      const reservationId = `res-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      data.reservedUsd = Number((data.reservedUsd + roundedAmount).toFixed(6));
      data.activeReservations[reservationId] = {
        model,
        amountUsd: roundedAmount,
        createdAt: new Date().toISOString()
      };

      data.transactions.push({
        id: `tx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'reserve',
        reservationId,
        model,
        amountUsd: roundedAmount
      });

      this.save(data);
      return reservationId;
    });
  }

  public commit(reservationId: string, actualCostUsd: number): void {
    if (typeof actualCostUsd !== 'number' || !Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
      throw new Error(`Invalid actual cost: ${actualCostUsd}`);
    }

    this.withLock(() => {
      const data = this.load();
      const res = data.activeReservations[reservationId];
      if (!res) {
        // Unknown reservation: must never free anything
        return;
      }

      const reservedAmount = res.amountUsd;
      const roundedActual = Number(actualCostUsd.toFixed(6));

      data.reservedUsd = Math.max(0, Number((data.reservedUsd - reservedAmount).toFixed(6)));
      data.spentUsd = Number((data.spentUsd + roundedActual).toFixed(6));
      delete data.activeReservations[reservationId];

      data.transactions.push({
        id: `tx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'commit',
        reservationId,
        model: res.model,
        amountUsd: roundedActual
      });

      this.save(data);
    });
  }

  public retainWorstCase(reservationId: string, reason: string): void {
    this.withLock(() => {
      const data = this.load();
      const res = data.activeReservations[reservationId];
      if (!res) {
        return;
      }

      const reservedAmount = res.amountUsd;
      data.reservedUsd = Math.max(0, Number((data.reservedUsd - reservedAmount).toFixed(6)));
      data.spentUsd = Number((data.spentUsd + reservedAmount).toFixed(6));
      delete data.activeReservations[reservationId];

      data.transactions.push({
        id: `tx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'retain_worst_case',
        reservationId,
        model: res.model,
        amountUsd: reservedAmount,
        reason
      });

      this.save(data);
    });
  }

  public release(reservationId: string): void {
    this.withLock(() => {
      const data = this.load();
      const res = data.activeReservations[reservationId];
      if (!res) {
        return;
      }

      data.reservedUsd = Math.max(0, Number((data.reservedUsd - res.amountUsd).toFixed(6)));
      delete data.activeReservations[reservationId];

      data.transactions.push({
        id: `tx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'release',
        reservationId,
        model: res.model,
        amountUsd: 0
      });

      this.save(data);
    });
  }

  public getStatus(): { totalBudgetUsd: number; spentUsd: number; reservedUsd: number; remainingUsd: number } {
    return this.withLock(() => {
      const data = this.load();
      const remaining = Math.max(0, Number((data.totalBudgetUsd - (data.spentUsd + data.reservedUsd)).toFixed(6)));
      return {
        totalBudgetUsd: data.totalBudgetUsd,
        spentUsd: data.spentUsd,
        reservedUsd: data.reservedUsd,
        remainingUsd: remaining
      };
    });
  }
}
