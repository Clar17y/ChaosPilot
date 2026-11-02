import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TargetVariant } from '../domain.ts';
import { recordValidationError, currentIdentityError, semanticRecordError } from './validation.ts';
import type { ApiJourneyRecord, ApiJourneySummary } from './types.ts';

export function validateApiJourneyRunId(id: string): boolean {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (id !== trimmed) return false;
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(trimmed)) return false;
  if (lower.includes('ledger') || lower.includes('..')) return false;
  return true;
}

export function resolveApiJourneyDir(runsDir = 'runs'): string {
  return path.join(runsDir, 'api-journeys');
}

export function resolveApiJourneyRunPath(runsDir: string, id: string): string {
  if (!validateApiJourneyRunId(id)) {
    throw new Error(`Invalid API journey run ID: "${id}"`);
  }
  const baseDir = path.resolve(resolveApiJourneyDir(runsDir));
  const targetPath = path.resolve(baseDir, id, 'record.json');
  if (!targetPath.startsWith(baseDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for API journey run ID: "${id}"`);
  }
  return targetPath;
}

export function isValidApiJourneyRecord(parsed: unknown, expectedId?: string): parsed is ApiJourneyRecord {
  if (recordValidationError(parsed, expectedId)) return false;
  const record = parsed as ApiJourneyRecord;
  return !!currentIdentityError(record) || !['pass', 'fail'].includes(record.status) || !semanticRecordError(record);
}

export async function saveApiJourneyRun(record: ApiJourneyRecord, runsDir = 'runs'): Promise<string> {
  // Capture bytes synchronously before any filesystem await or caller mutation.
  const bytes = JSON.stringify(record, null, 2);
  const captured = JSON.parse(bytes) as ApiJourneyRecord;
  record = captured;
  if (!validateApiJourneyRunId(record.id)) {
    throw new Error(`Invalid API journey run ID: "${record.id}"`);
  }
  if (!isValidApiJourneyRecord(record, record.id)) {
    throw new Error('Attempted to save an invalid API journey record');
  }

  const runPath = resolveApiJourneyRunPath(runsDir, record.id);
  const runDir = path.dirname(runPath);
  await fs.mkdir(runDir, { recursive: true });

  const tempPath = path.join(
    runDir,
    `.tmp-${record.id}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  let ownsTemp = false;
  try {
    const file = await fs.open(tempPath, 'wx');
    ownsTemp = true;
    try { await file.writeFile(bytes, 'utf8'); } finally { await file.close(); }
    try {
      // Hard-link publication exposes the completed inode atomically and never replaces a winner.
      await fs.link(tempPath, runPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`API journey run record "${record.id}" already exists and cannot be overwritten`, {
          cause: err,
        });
      }
      throw new Error('Atomic exclusive API journey publication failed; filesystem must support same-volume hard links', { cause: err });
    }
  } finally {
    if (ownsTemp) await fs.unlink(tempPath).catch(() => {});
  }
  return runPath;
}

export async function getApiJourneyRun(id: string, runsDir = 'runs'): Promise<ApiJourneyRecord | null> {
  if (!validateApiJourneyRunId(id)) return null;

  try {
    const runPath = resolveApiJourneyRunPath(runsDir, id);
    const content = await fs.readFile(runPath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidApiJourneyRecord(parsed, id)) return null;
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listApiJourneyRuns(runsDir = 'runs'): Promise<ApiJourneySummary[]> {
  const dir = path.resolve(resolveApiJourneyDir(runsDir));
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const summaries: ApiJourneySummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !validateApiJourneyRunId(entry.name)) continue;
      const recordPath = path.join(dir, entry.name, 'record.json');
      try {
        const content = await fs.readFile(recordPath, 'utf8');
        const parsed: unknown = JSON.parse(content);
        if (isValidApiJourneyRecord(parsed, entry.name)) {
          const brief = parsed.systemSnapshot.brief;
          summaries.push({
            id: parsed.id,
            startedAt: parsed.startedAt,
            finishedAt: parsed.finishedAt,
            adapterId: parsed.adapterId,
            variant: parsed.variant as TargetVariant,
            systemBrief: {
              id: brief.id,
              name: brief.name,
              revision: brief.revision,
            },
            status: parsed.status,
            journeyCount: parsed.journeys.length,
          });
        }
      } catch {
        // Skip unreadable or corrupted run records
      }
    }

    summaries.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return summaries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
