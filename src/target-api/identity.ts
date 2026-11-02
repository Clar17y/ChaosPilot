import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../evidence.ts';
import type { Identity } from './types.ts';

export const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

function readClosureFiles(files: readonly string[]): { path: string; content: string }[] {
  return files.map((file) => {
    const fileUrl = new URL(file + extension, import.meta.url);
    const content = readFileSync(fileUrl, 'utf8').replace(/\r\n/g, '\n');
    return { path: file, content };
  });
}

function computeIdentityHash(entries: { path: string; content: string }[]): string {
  return digest(entries.map((e) => e.content));
}

const TRANSPORT_FILES = ['./target', './client', './runner', './types', './identity', '../evidence'] as const;
const EVALUATOR_FILES = [
  './catalog',
  './evaluator',
  './validation',
  './compare',
  '../requirements/identity',
  '../systems/index',
  './identity',
  '../evidence',
  '../simulator/oracle',
  '../requirements/evaluator',
] as const;

// Capture truthful identities upon module load into immutable structures
const loadedTransportEntries = readClosureFiles(TRANSPORT_FILES);
const loadedTransportIdentity: Identity = {
  version: 1,
  hash: computeIdentityHash(loadedTransportEntries),
};

const loadedEvaluatorEntries = readClosureFiles(EVALUATOR_FILES);
const loadedEvaluatorIdentity: Identity = {
  version: 1,
  hash: computeIdentityHash(loadedEvaluatorEntries),
};

export function transportIdentity(): Identity {
  let currentEntries: { path: string; content: string }[];
  try {
    currentEntries = readClosureFiles(TRANSPORT_FILES);
  } catch (error) {
    throw new Error('Target API transport runtime source changed or is missing; restart required before continuing.', {
      cause: error,
    });
  }
  const currentHash = computeIdentityHash(currentEntries);
  if (
    currentHash !== loadedTransportIdentity.hash ||
    currentEntries.some((e, i) => e.content !== loadedTransportEntries[i]?.content)
  ) {
    throw new Error('Target API transport runtime source changed on disk; restart required before continuing.');
  }
  return { ...loadedTransportIdentity };
}

export function evaluatorIdentity(): Identity {
  let currentEntries: { path: string; content: string }[];
  try {
    currentEntries = readClosureFiles(EVALUATOR_FILES);
  } catch (error) {
    throw new Error('Target API evaluator runtime source changed or is missing; restart required before continuing.', {
      cause: error,
    });
  }
  const currentHash = computeIdentityHash(currentEntries);
  if (
    currentHash !== loadedEvaluatorIdentity.hash ||
    currentEntries.some((e, i) => e.content !== loadedEvaluatorEntries[i]?.content)
  ) {
    throw new Error('Target API evaluator runtime source changed on disk; restart required before continuing.');
  }
  return { ...loadedEvaluatorIdentity };
}
