import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getRun, getRunRevision, validateRunId, withRunMutation } from '../storage.ts';
import { evidenceHashOf } from '../explanations/index.ts';
import type { InvestigationRecord } from '../domain.ts';
import type { ChallengeRecord } from './types.ts';

function location(runId: string, findingId: string, runsDir: string): string {
  if (!validateRunId(runId) || typeof findingId !== 'string' || !findingId || findingId.length > 256) throw new Error('Invalid challenge identity');
  const key = crypto.createHash('sha256').update(findingId).digest('hex');
  return path.join(path.resolve(runsDir), 'challenges', runId, key);
}

export async function withChallengeGeneration<T>(runId: string, findingId: string, runsDir: string, action: () => Promise<T>): Promise<T> {
  const dir = location(runId, findingId, runsDir);
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'generation.lock');
  let handle: fs.FileHandle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A challenge is already being generated for this finding. Wait for it to finish; inspect the generation lock if interrupted.');
    throw error;
  }
  try { return await action(); }
  finally { await handle.close(); await fs.unlink(lock); }
}

export async function challengeInFlight(runId: string, findingId: string, runsDir: string): Promise<boolean> {
  try { await fs.access(path.join(location(runId, findingId, runsDir), 'generation.lock')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function readChallengeSource(runId: string, runsDir: string): Promise<{ record: InvestigationRecord; revision: string }> {
  return withRunMutation(runId, runsDir, async () => {
    const record = await getRun(runId, runsDir);
    if (!record) throw new Error('Run was deleted or is missing or malformed.');
    return { record, revision: await getRunRevision(runId, runsDir) };
  });
}

interface Manifest { latestAttempt: string; latestEvidence?: string; latestCompleted?: string; latestPartial?: string }
async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as Manifest;
    if (
      !validId(m.latestAttempt) ||
      (m.latestEvidence !== undefined && !validId(m.latestEvidence)) ||
      (m.latestCompleted !== undefined && !validId(m.latestCompleted)) ||
      (m.latestPartial !== undefined && !validId(m.latestPartial))
    ) throw new Error('Invalid challenge manifest');
    return m;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
async function atomicJson(file: string, data: unknown): Promise<void> {
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  try { await fs.writeFile(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** Evidence checkpoints may persist after cancellation; they never execute more work. */
export async function saveChallenge(record: ChallengeRecord, runsDir: string): Promise<void> {
  const b = record.binding;
  if (!validId(record.id)) throw new Error('Invalid challenge attempt ID');
  await withRunMutation(b.runId, runsDir, async () => {
    const current = await getRun(b.runId, runsDir);
    if (!current || current.status === 'running' || evidenceHashOf(current) !== b.evidenceHash || await getRunRevision(b.runId, runsDir) !== b.runRevision) {
      throw new Error('Run was deleted or changed during the challenge. No current challenge was published.');
    }
    const dir = location(b.runId, b.findingId, runsDir);
    await fs.mkdir(dir, { recursive: true });
    const previous = await readManifest(dir);
    await atomicJson(path.join(dir, `${record.id}.json`), record);
    // A rejected proposal cannot displace earlier observed evidence. All attempts remain inspectable.
    const hasEvidence = record.variants.some(v => v.candidate !== undefined);
    const isCompleted = hasEvidence && record.status === 'completed';
    const isPartial = hasEvidence && record.status !== 'completed';
    const latestCompleted = isCompleted ? record.id : (previous?.latestCompleted ?? (previous?.latestEvidence ? previous.latestEvidence : undefined));
    const latestPartial = isPartial ? record.id : previous?.latestPartial;
    const latestEvidence = isCompleted ? record.id : (previous?.latestEvidence ?? latestCompleted);
    await atomicJson(path.join(dir, 'index.json'), {
      latestAttempt: record.id,
      ...(latestEvidence ? { latestEvidence } : {}),
      ...(latestCompleted ? { latestCompleted } : {}),
      ...(latestPartial ? { latestPartial } : {}),
    } satisfies Manifest);
  });
}

/** Return artifacts only while the exact saved run version still exists. */
export async function readChallenges(runId: string, findingId: string, runsDir: string): Promise<{
  current: ChallengeRecord | null; latestPartial: ChallengeRecord | null; latestAttempt: ChallengeRecord | null; stale: boolean;
}> {
  return withRunMutation(runId, runsDir, async () => {
    const source = await getRun(runId, runsDir);
    if (!source) throw new Error('Run was deleted or is missing.');
    const dir = location(runId, findingId, runsDir);
    const manifest = await readManifest(dir);
    if (!manifest) return { current: null, latestPartial: null, latestAttempt: null, stale: false };
    const revision = await getRunRevision(runId, runsDir);
    const hash = evidenceHashOf(source);
    let stale = false;
    const load = async (id?: string): Promise<ChallengeRecord | null> => {
      if (!id) return null;
      const artifact = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')) as ChallengeRecord;
      const b = artifact.binding;
      if (artifact.id !== id || b?.runId !== runId || b?.findingId !== findingId) throw new Error('Challenge artifact identity mismatch');
      if (b.evidenceHash !== hash || b.runRevision !== revision || source.status === 'running') { stale = true; return null; }
      return artifact;
    };
    const completedRecord = await load(manifest.latestCompleted ?? manifest.latestEvidence);
    const latestPartial = await load(manifest.latestPartial);
    const latestAttempt = await load(manifest.latestAttempt);

    let current = completedRecord;
    if (!current) {
      if (latestPartial?.variants.some(v => v.candidate !== undefined)) current = latestPartial;
      else if (latestAttempt?.variants.some(v => v.candidate !== undefined)) current = latestAttempt;
    }
    return { current, latestPartial: latestPartial ?? null, latestAttempt, stale };
  });
}
