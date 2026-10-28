import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type {
  RequirementEvaluatorIdentity,
  RequirementRule,
  SystemBrief,
  SystemBriefSnapshot,
  SystemContract,
} from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import { resolveAdapter } from '../adapters/index.ts';
import { cloneRequirementRules, validateRequirementRules } from '../requirements/config.ts';
import { getRequirementEvaluatorIdentity } from '../requirements/identity.ts';

export class SystemIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemIntegrityError';
  }
}

export class SystemConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemConflictError';
  }
}

export class SystemNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemNotFoundError';
  }
}

export class SystemRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemRevisionConflictError';
  }
}

export class SystemLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemLockTimeoutError';
  }
}

export class SystemLockReleaseError extends Error {
  readonly lockPath: string;
  readonly systemId: string;
  constructor(message: string, lockPath: string, systemId: string, cause?: unknown) {
    super(message);
    this.name = 'SystemLockReleaseError';
    this.lockPath = lockPath;
    this.systemId = systemId;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export const SEEDED_TRADING_BRIEF: Readonly<SystemBrief> = Object.freeze({
  schemaVersion: 1,
  id: 'trading-gateway',
  revision: 1,
  name: 'ChaosPilot Trading Gateway',
  overview:
    'Deterministic single-account trading gateway with credit reservation, quote locking, and venue execution reconciliation.',
  requirements: [
    'Quotes and credit-limit updates are versioned; older or repeated versions must not change state.',
    'Accepted orders lock their quote price, reserve credit and follow an explicit lifecycle.',
    'Total commitments include both used and reserved credit. New order admission respects the current limit.',
    'A limit reduction constrains future commitments. Fills already reported to a client are honoured; do not retroactively invalidate them.',
    'Unique fills convert reservation into used credit once. Duplicate and conflicting reports have different rejection/idempotency requirements.',
    'Cancellation releases only confirmed cancelled quantity. A fill that occurred before cancellation can legitimately arrive after the cancellation acknowledgement.',
    'Malformed or rejected payloads must not mutate business state or poison future identifiers.',
  ],
  adapterId: 'synthetic-trading',
  updatedAt: '2026-10-26T00:00:00.000Z',
});

export const SEEDED_INVENTORY_BRIEF: Readonly<SystemBrief> = Object.freeze({
  schemaVersion: 1, id: 'inventory-reservation', revision: 1,
  name: 'Inventory reservation service',
  overview: 'Deterministic stock receipts, reservations, cancellation and shipment with explicit message delivery.',
  requirements: [
    'Reservations may not exceed available stock; shipments and cancellation conserve quantities.',
    'Accepted event ids are idempotent, conflicting ids are rejected, and rejected input leaves business state unchanged.',
  ],
  adapterId: 'inventory-reservation', updatedAt: '2026-10-27T00:00:00.000Z',
});

const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function isValidIsoDateString(str: unknown): boolean {
  if (typeof str !== 'string' || str.trim().length === 0) return false;
  // Strict ISO 8601 UTC or timezone-offset pattern
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/;
  if (!isoPattern.test(str)) return false;
  const timestamp = Date.parse(str);
  return !Number.isNaN(timestamp);
}

export function validateSystemId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  // Strict canonical identity: exact trimmed string (no leading/trailing whitespace)
  if (id !== id.trim()) return false;
  if (id.length < 3 || id.length > 64) return false;
  // Canonical lowercase format: alphanumeric, dash, underscore
  if (!/^[a-z0-9_-]+$/.test(id)) return false;
  // Reject Windows reserved device basenames
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(id.toLowerCase())) return false;
  return true;
}

export function validateSystemBrief(
  input: unknown
): { valid: true; brief: SystemBrief } | { valid: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'System brief payload must be an object' };
  }

  const b = input as Record<string, unknown>;

  if (b.schemaVersion !== 1) {
    return { valid: false, error: 'System brief schemaVersion must be 1' };
  }

  if (!validateSystemId(b.id)) {
    return {
      valid: false,
      error: 'Invalid system ID: must be 3-64 canonical lowercase alphanumeric/dash/underscore characters and cannot be a Windows reserved device name',
    };
  }

  if (
    typeof b.revision !== 'number' ||
    !Number.isSafeInteger(b.revision) ||
    b.revision < 1 ||
    b.revision > Number.MAX_SAFE_INTEGER
  ) {
    return { valid: false, error: 'revision must be a safe positive integer >= 1' };
  }

  if (typeof b.name !== 'string' || b.name.trim().length === 0 || b.name.trim().length > 120) {
    return { valid: false, error: 'name must be a non-empty string of at most 120 characters' };
  }

  if (typeof b.overview !== 'string' || b.overview.length > 2000) {
    return { valid: false, error: 'overview must be a string of at most 2000 characters' };
  }

  if (!Array.isArray(b.requirements)) {
    return { valid: false, error: 'requirements must be an array of strings' };
  }

  if (b.requirements.length > 50) {
    return { valid: false, error: 'requirements array cannot exceed 50 items' };
  }

  for (let i = 0; i < b.requirements.length; i++) {
    const item = b.requirements[i];
    if (typeof item !== 'string' || item.length > 500) {
      return {
        valid: false,
        error: `requirements[${i}] must be a string of at most 500 characters`,
      };
    }
  }

  if (b.adapterId !== 'synthetic-trading' && b.adapterId !== 'inventory-reservation' && b.adapterId !== 'unconfigured') {
    return {
      valid: false,
      error: "adapterId must be 'synthetic-trading', 'inventory-reservation' or 'unconfigured'",
    };
  }

  if (typeof b.updatedAt !== 'string' || !isValidIsoDateString(b.updatedAt)) {
    return { valid: false, error: 'updatedAt must be a valid ISO 8601 date string' };
  }

  const requirements = b.requirements.map((r: string) => r.trim()).filter((r: string) => r.length > 0);

  // Optional reviewed requirement rules. Absent stays absent so legacy
  // briefs/snapshots keep their canonical hashes; a present field must be a
  // valid allowlisted preset configuration bound to unique requirement text.
  let requirementRules: RequirementRule[] | undefined;
  if (b.requirementRules !== undefined) {
    const rulesError = validateRequirementRules(b.requirementRules, requirements, b.adapterId);
    if (rulesError) {
      return { valid: false, error: rulesError };
    }
    requirementRules = cloneRequirementRules(b.requirementRules as RequirementRule[]);
  }

  return {
    valid: true,
    brief: {
      schemaVersion: 1,
      id: b.id,
      revision: b.revision,
      name: b.name.trim(),
      overview: b.overview,
      requirements,
      ...(requirementRules !== undefined ? { requirementRules } : {}),
      adapterId: b.adapterId,
      updatedAt: b.updatedAt,
    },
  };
}

export function computeSnapshotHash(
  brief: SystemBrief,
  contract: SystemContract | null,
  requirementEvaluator?: RequirementEvaluatorIdentity
): string {
  // Without an evaluator identity this is exactly the historical hash, so
  // old snapshots (whose optional fields were absent) keep verifying.
  // When rules are pinned, the evaluator identity is bound into the hash.
  const payload = requirementEvaluator === undefined
    ? { brief, contract }
    : { brief, contract, requirementEvaluator };
  return crypto
    .createHash('sha256')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

export function resolveSystemPath(systemsDir: string, id: string): string {
  if (!validateSystemId(id)) {
    throw new Error(`Invalid system ID: "${id}"`);
  }
  const resolvedDir = path.resolve(systemsDir);
  const resolvedPath = path.resolve(resolvedDir, `${id}.json`);
  const relative = path.relative(resolvedDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative !== `${id}.json`) {
    throw new Error(`Path traversal attempt detected for system ID: "${id}"`);
  }
  return resolvedPath;
}

const LOCK_RELEASE_ATTEMPTS = 5;

function lockErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function unlinkLockWithRetry(lockFilePath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOCK_RELEASE_ATTEMPTS; attempt++) {
    try {
      await fs.unlink(lockFilePath);
      return;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'ENOENT') return;
      lastError = e;
      if (attempt < LOCK_RELEASE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }
  throw lastError;
}

const RECOVERY_HINT =
  'The lock file was left in place. Remove it manually only after verifying no writer is actively using it; ' +
  'the guarded operation may have completed and its changes may have been saved, so verify current state before retrying.';

async function releaseOwnedLock(
  lockFilePath: string,
  lockToken: string,
  systemId: string
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(lockFilePath, 'utf8');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'ENOENT') return;
    throw new SystemLockReleaseError(
      `Failed to release lock for system "${systemId}": could not verify lock ownership at ${lockFilePath} (${lockErrorMessage(e)}). ${RECOVERY_HINT}`,
      lockFilePath,
      systemId,
      e
    );
  }
  if (content !== lockToken) {
    throw new SystemLockReleaseError(
      `Failed to release lock for system "${systemId}": lock ownership mismatch at ${lockFilePath}; the lock file does not belong to this invocation and was not removed. ${RECOVERY_HINT}`,
      lockFilePath,
      systemId
    );
  }
  try {
    await unlinkLockWithRetry(lockFilePath);
  } catch (e: unknown) {
    throw new SystemLockReleaseError(
      `Failed to release lock for system "${systemId}": could not remove lock file at ${lockFilePath} after ${LOCK_RELEASE_ATTEMPTS} attempts (${lockErrorMessage(e)}). ${RECOVERY_HINT}`,
      lockFilePath,
      systemId,
      e
    );
  }
}

export async function withSystemLock<T>(
  systemsDir: string,
  systemId: string,
  operation: () => Promise<T>,
  timeoutMs = 10000
): Promise<T> {
  const canonicalId = systemId.toLowerCase();
  const resolvedSystemsDir = path.resolve(systemsDir);
  const locksDir = path.join(resolvedSystemsDir, '.locks');
  await fs.mkdir(locksDir, { recursive: true });
  const lockFilePath = path.join(locksDir, `${canonicalId}.lock`);

  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const startTime = Date.now();
  let acquired = false;

  while (!acquired) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(lockFilePath, 'wx');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // On Windows, concurrent open/unlink can transiently yield EEXIST, EPERM, or EBUSY
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') {
        if (Date.now() - startTime >= timeoutMs) {
          // NEVER steal lock or infer abandonment from age!
          throw new SystemLockTimeoutError(
            `Lock acquisition timed out for system "${systemId}" after ${timeoutMs}ms`
          );
        }
        const delay = 10 + Math.floor(Math.random() * 20);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }

    // Ownership begins immediately after exclusive creation, before token write/close.
    let setupError: unknown;
    let hasSetupError = false;
    try {
      await handle.writeFile(lockToken, 'utf8');
    } catch (e: unknown) {
      setupError = e;
      hasSetupError = true;
    }
    try {
      await handle.close();
    } catch (e: unknown) {
      if (!hasSetupError) {
        setupError = e;
        hasSetupError = true;
      }
    }
    if (hasSetupError) {
      // This invocation created the file exclusively, so it owns cleanup even
      // when the token was only partially written. Never treat this as contention.
      try {
        await unlinkLockWithRetry(lockFilePath);
      } catch (cleanupError: unknown) {
        throw new SystemLockReleaseError(
          `Failed to set up lock for system "${systemId}" (${lockErrorMessage(setupError)}) and failed to clean up the owned lock file at ${lockFilePath} after ${LOCK_RELEASE_ATTEMPTS} attempts (${lockErrorMessage(cleanupError)}). ${RECOVERY_HINT}`,
          lockFilePath,
          systemId,
          setupError
        );
      }
      throw setupError;
    }
    acquired = true;
  }

  let operationResult: T;
  let operationError: unknown;
  let hasOperationError = false;
  try {
    operationResult = await operation();
  } catch (e: unknown) {
    hasOperationError = true;
    operationError = e;
    operationResult = undefined as T;
  }

  try {
    await releaseOwnedLock(lockFilePath, lockToken, systemId);
  } catch (releaseError: unknown) {
    if (hasOperationError) {
      throw new SystemLockReleaseError(
        `Operation failed for system "${systemId}" (${lockErrorMessage(operationError)}) and lock release also failed: ${lockErrorMessage(releaseError)}`,
        lockFilePath,
        systemId,
        operationError
      );
    }
    throw releaseError;
  }

  if (hasOperationError) throw operationError;
  return operationResult!;
}

export async function readSystemBriefFile(
  filePath: string,
  expectedId: string
): Promise<SystemBrief> {
  const content = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new SystemIntegrityError(
      `Corrupted system brief file for "${expectedId}": Invalid JSON syntax (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const validated = validateSystemBrief(parsed);
  if (!validated.valid) {
    throw new SystemIntegrityError(
      `Corrupted system brief file for "${expectedId}": ${validated.error}`
    );
  }

  if (validated.brief.id !== expectedId) {
    throw new SystemIntegrityError(
      `Corrupted system brief file for "${expectedId}": File content ID "${validated.brief.id}" does not match file ID "${expectedId}"`
    );
  }

  return validated.brief;
}

async function ensureSeededBrief(systemsDir: string, seed: Readonly<SystemBrief>): Promise<SystemBrief> {
  await fs.mkdir(systemsDir, { recursive: true });
  const seededId = seed.id;
  const seededPath = resolveSystemPath(systemsDir, seededId);

  return withSystemLock(systemsDir, seededId, async () => {
    try {
      return await readSystemBriefFile(seededPath, seededId);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        // Seed ONLY on actual ENOENT
        const seeded: SystemBrief = structuredClone(seed);
        seeded.updatedAt = new Date().toISOString();
        const serialized = JSON.stringify(seeded, null, 2);
        const tempPath = path.join(
          systemsDir,
          `.tmp-${seeded.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
        );
        await fs.writeFile(tempPath, serialized, 'utf8');
        await fs.rename(tempPath, seededPath);
        return seeded;
      }
      // Malformed / unreadable / corrupt existing data must fail visibly and remain byte-identical
      throw err;
    }
  });
}

export async function ensureSeededSystem(systemsDir: string): Promise<SystemBrief> {
  const trading = await ensureSeededBrief(systemsDir, SEEDED_TRADING_BRIEF);
  await ensureSeededBrief(systemsDir, SEEDED_INVENTORY_BRIEF);
  return trading;
}

export async function getSystemBrief(
  id: string,
  systemsDir: string
): Promise<SystemBrief | null> {
  if (!validateSystemId(id)) return null;

  const filePath = resolveSystemPath(systemsDir, id);
  try {
    return await readSystemBriefFile(filePath, id);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      if (id === SEEDED_TRADING_BRIEF.id || id === SEEDED_INVENTORY_BRIEF.id) {
        await ensureSeededSystem(systemsDir);
        return readSystemBriefFile(filePath, id);
      }
      return null;
    }
    // Malformed / integrity errors must bubble visibly rather than returning null
    throw err;
  }
}

export async function listSystemBriefs(systemsDir: string): Promise<SystemBrief[]> {
  await fs.mkdir(systemsDir, { recursive: true });
  await ensureSeededSystem(systemsDir);

  const entries = await fs.readdir(systemsDir, { withFileTypes: true });
  const briefs: SystemBrief[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) {
      continue;
    }
    const id = entry.name.slice(0, -'.json'.length);
    if (!validateSystemId(id)) continue;

    const filePath = resolveSystemPath(systemsDir, id);
    const brief = await readSystemBriefFile(filePath, id);
    briefs.push(brief);
  }

  briefs.sort((a, b) => a.name.localeCompare(b.name));
  return briefs;
}

export interface SaveSystemOptions {
  expectedRevision?: number;
  mode?: 'create' | 'update' | 'upsert';
}

export async function saveSystemBrief(
  briefInput: unknown,
  systemsDir: string,
  options: SaveSystemOptions = {}
): Promise<SystemBrief> {
  const validated = validateSystemBrief(briefInput);
  if (!validated.valid) {
    throw new Error(`Invalid system brief: ${validated.error}`);
  }

  const brief = validated.brief;
  await fs.mkdir(systemsDir, { recursive: true });
  const finalPath = resolveSystemPath(systemsDir, brief.id);
  const mode = options.mode || 'upsert';

  return withSystemLock(systemsDir, brief.id, async () => {
    let existingBrief: SystemBrief | null = null;
    try {
      existingBrief = await readSystemBriefFile(finalPath, brief.id);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        existingBrief = null;
      } else {
        // If file exists and is corrupt, do NOT treat as absent and do NOT overwrite
        throw err;
      }
    }

    if (mode === 'create' && existingBrief) {
      throw new SystemConflictError(
        `System brief "${brief.id}" already exists`
      );
    }

    if (mode === 'update' && !existingBrief) {
      throw new SystemNotFoundError(
        `System brief "${brief.id}" not found`
      );
    }

    let nextRevision: number;

    if (existingBrief) {
      // Optimistic concurrency check
      if (
        options.expectedRevision !== undefined &&
        existingBrief.revision !== options.expectedRevision
      ) {
        throw new SystemRevisionConflictError(
          `Revision conflict: current revision is ${existingBrief.revision}, but expected ${options.expectedRevision}`
        );
      }
      if (brief.revision !== existingBrief.revision) {
        throw new SystemRevisionConflictError(
          `Revision conflict: provided revision ${brief.revision} does not match current revision ${existingBrief.revision}`
        );
      }
      if (existingBrief.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `Revision integer overflow: system brief "${brief.id}" has reached maximum revision`
        );
      }
      nextRevision = existingBrief.revision + 1;
    } else {
      // New brief creation: must start at revision 1
      if (brief.revision !== 1) {
        throw new Error(
          `Initial revision for new system brief "${brief.id}" must be 1, got ${brief.revision}`
        );
      }
      nextRevision = 1;
    }

    const updatedBrief: SystemBrief = {
      ...brief,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
    };

    const tempPath = path.join(
      systemsDir,
      `.tmp-${updatedBrief.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    const serialized = JSON.stringify(updatedBrief, null, 2);
    await fs.writeFile(tempPath, serialized, 'utf8');
    await fs.rename(tempPath, finalPath);

    return updatedBrief;
  });
}

export async function createSystemBrief(
  briefInput: unknown,
  systemsDir: string
): Promise<SystemBrief> {
  return saveSystemBrief(briefInput, systemsDir, { mode: 'create' });
}

export async function updateSystemBrief(
  briefInput: unknown,
  systemsDir: string,
  options: SaveSystemOptions = {}
): Promise<SystemBrief> {
  return saveSystemBrief(briefInput, systemsDir, { ...options, mode: 'update' });
}

export async function createSystemSnapshot(
  brief: SystemBrief,
  contractOverride?: SystemContract | null
): Promise<SystemBriefSnapshot> {
  const validated = validateSystemBrief(brief);
  if (!validated.valid) throw new SystemIntegrityError(validated.error);
  const canonicalBrief = validated.brief;
  const contract = canonicalBrief.adapterId === 'unconfigured' ? null
    : contractOverride !== undefined ? contractOverride : resolveAdapter(canonicalBrief.adapterId).getContract();

  const hasRules = (canonicalBrief.requirementRules?.length ?? 0) > 0;
  const requirementEvaluator = hasRules ? getRequirementEvaluatorIdentity() : undefined;
  const hash = computeSnapshotHash(canonicalBrief, contract, requirementEvaluator);

  return {
    brief: structuredClone(canonicalBrief),
    contract: contract ? structuredClone(contract) : null,
    hash,
    ...(requirementEvaluator ? { requirementEvaluator } : {}),
  };
}
