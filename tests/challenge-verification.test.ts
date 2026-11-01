import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChaosPilotServer } from '../src/server.ts';
import * as storage from '../src/storage.ts';
import { saveRun } from '../src/storage.ts';
import { resolveAdapter } from '../src/adapters/index.ts';
import { challengeFinding, getChallengeView, validateChallengePreconditions } from '../src/challenges/index.ts';
import { readChallenges } from '../src/challenges/storage.ts';
import { ChallengeSession, challengeRecordHash } from '../src/web/challenges.ts';
import {
  cleanupVerificationView,
  deriveStageStates,
  getOrCreateViewState,
  renderSourceViewer,
  renderWatchVerificationView,
  stopPlayback,
  type VerificationViewState,
} from '../src/web/challenge-verification.ts';
import type { ChallengeRecord, ChallengeView } from '../src/challenges/types.ts';
import {
  api,
  challengeFixture,
  deferred,
  fakeTransport,
  proposalFor,
  tempChallengeDir,
  usage,
} from './challenge-fixtures.ts';

const dirs: string[] = [];
const sessions: ChallengeSession[] = [];
const reply = (json: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const settled = async (s: ChallengeSession) => { await vi.waitFor(() => expect(s.state).not.toBe('loading')); };

async function setup(inventory = false) {
  const dir = await tempChallengeDir();
  dirs.push(dir);
  const record = await challengeFixture(inventory);
  await saveRun(record, dir);
  const findingId = record.findings[0]!.id;
  const url = `/api/runs/${record.id}/challenges`;
  const getUrl = `${url}?findingId=${encodeURIComponent(findingId)}`;
  return { dir, record, findingId, url, getUrl };
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new MockElement(tag),
  });
});

afterEach(async () => {
  sessions.splice(0).forEach(s => s.select(null, null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

// Helper for test DOM mock
class MockElement {
  children: MockElement[] = [];
  textContent = '';
  disabled = false;
  attrs: Record<string, string> = {};
  className = '';
  listeners: Record<string, ((e: any) => void)[]> = {};

  constructor(readonly tag: string, readonly id = '') {}

  set innerHTML(_v: string) { throw new Error('Unsafe HTML rendering forbidden'); }

  append(...children: (MockElement | string)[]) {
    for (const c of children) {
      if (typeof c === 'string') {
        const textEl = new MockElement('span');
        textEl.textContent = c;
        this.children.push(textEl);
      } else if (c instanceof MockElement) {
        this.children.push(c);
      }
    }
  }

  replaceChildren(...children: MockElement[]) {
    this.children = [...children];
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  get classList() {
    return {
      add: (cls: string) => {
        const parts = this.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(cls)) {
          parts.push(cls);
          this.className = parts.join(' ');
        }
      },
      remove: (cls: string) => {
        this.className = this.className.split(/\s+/).filter(c => c !== cls).join(' ');
      },
      contains: (cls: string) => this.className.split(/\s+/).includes(cls),
    };
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      if (this.id === id) return this;
      for (const c of this.children) {
        const found = c.querySelector(selector);
        if (found) return found;
      }
    } else if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.className.split(/\s+/).includes(cls)) return this;
      for (const c of this.children) {
        const found = c.querySelector(selector);
        if (found) return found;
      }
    } else {
      if (this.tag === selector) return this;
      for (const c of this.children) {
        const found = c.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.className.split(/\s+/).includes(cls)) results.push(this);
    } else if (this.tag === selector) {
      results.push(this);
    }
    for (const c of this.children) {
      results.push(...c.querySelectorAll(selector));
    }
    return results;
  }

  addEventListener(event: string, handler: (e: any) => void) {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event]!.push(handler);
  }

  dispatchEvent(event: string, data: any = {}) {
    for (const h of this.listeners[event] ?? []) h(data);
  }

  allText(): string {
    return [this.textContent, ...this.children.map(c => c.allText())].join('\n');
  }

  allTags(): string[] {
    return [this.tag, ...this.children.flatMap(c => c.allTags())];
  }
}

describe('Watch Verification Contract: 7 Critical Invariants', () => {

  describe('Invariant 2: Progress is observational and GET calls never execute simulations', () => {
    it('observes real proposal/candidate/replay/clean/interpretation stages and GET calls do not execute code', async () => {
      const { dir, record, findingId, getUrl } = await setup();
      const enteredProposal = deferred();
      const releaseProposal = deferred();
      const enteredInterpretation = deferred();
      const releaseInterpretation = deferred();
      let proposalCalls = 0;
      let interpCalls = 0;

      const transport = {
        generate: async (system: string) => {
          if (system.includes('Propose bounded deterministic variations')) {
            proposalCalls++;
            enteredProposal.resolve();
            await releaseProposal.promise;
            return { content: proposalFor(record, 1), usage };
          }
          if (system.includes('Interpret the supplied')) {
            interpCalls++;
            enteredInterpretation.resolve();
            await releaseInterpretation.promise;
            return { content: JSON.stringify({ interpretation: 'Deterministic challenge observed' }), usage };
          }
          throw new Error('Unexpected system prompt');
        },
      };

      const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: transport });
      const adapter = resolveAdapter(record.contextAudit.adapterId ?? 'synthetic-trading');
      const executeSpy = vi.spyOn(adapter, 'executeExperiment');

      // 1. Initial view before POST
      const initialView = (await api(server, 'GET', getUrl)).json as ChallengeView;
      expect(initialView.available).toBe(true);
      expect(initialView.inFlight).toBe(false);
      expect(executeSpy).toHaveBeenCalledTimes(0);

      // 2. Start POST and hold in proposal stage
      const postPromise = challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport,
      });

      await enteredProposal.promise;

      // Poll progress during proposal stage
      const viewDuringProposal = (await api(server, 'GET', getUrl)).json as ChallengeView;
      expect(viewDuringProposal.inFlight).toBe(true);
      expect(viewDuringProposal.latestAttempt).not.toBeNull();
      expect(viewDuringProposal.latestAttempt?.stage?.stage).toBe('proposal');
      expect(viewDuringProposal.latestAttempt?.status).toBe('running');

      // Read GET again multiple times: assert executeExperiment call count remains unchanged
      const baselineExecutions = executeSpy.mock.calls.length; // 1 from prepareChallenge preflight
      await api(server, 'GET', getUrl);
      await api(server, 'GET', getUrl);
      expect(executeSpy.mock.calls.length).toBe(baselineExecutions);

      // 3. Release proposal and wait until interpretation starts
      releaseProposal.resolve();
      await enteredInterpretation.promise;

      // Poll progress during interpretation stage
      const viewDuringInterp = (await api(server, 'GET', getUrl)).json as ChallengeView;
      expect(viewDuringInterp.inFlight).toBe(true);
      expect(viewDuringInterp.latestAttempt?.stage?.stage).toBe('interpretation');
      expect(viewDuringInterp.latestAttempt?.variants).toHaveLength(1);
      const variant = viewDuringInterp.latestAttempt?.variants[0]!;
      expect(variant.candidate).toBeDefined();
      expect(variant.replay).toBeDefined();
      expect(variant.clean).toBeDefined();

      // Read GET repeatedly: executeExperiment call count must NOT increase
      const execCountAfterVariants = executeSpy.mock.calls.length;
      await api(server, 'GET', getUrl);
      await api(server, 'GET', getUrl);
      expect(executeSpy.mock.calls.length).toBe(execCountAfterVariants);

      // 4. Release interpretation and await completion
      releaseInterpretation.resolve();
      const completed = await postPromise;
      expect(completed.status).toBe('completed');
      expect(completed.stage?.stage).toBe('terminal');
      expect(completed.stage?.detail).toBe('Challenge completed');

      // Final GET: completed result saved and view available
      const finalView = (await api(server, 'GET', getUrl)).json as ChallengeView;
      expect(finalView.inFlight).toBe(false);
      expect(finalView.current?.id).toBe(completed.id);
      expect(finalView.current?.stage?.stage).toBe('terminal');
      expect(proposalCalls).toBe(1);
      expect(interpCalls).toBe(1);
    });
  });

  describe('Invariant 3: Stable identity, provenance-matched source and legacy degradation', () => {
    it('captures verified executed candidate and clean source bundles in challenge record', async () => {
      const { dir, record, findingId } = await setup();
      const fake = fakeTransport(record);
      const result = await challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport: fake.transport,
      });

      expect(result.sources).toBeDefined();
      expect(result.sources?.candidate).toBeDefined();
      expect(result.sources?.clean).toBeDefined();

      const candidateBundle = result.sources!.candidate!;
      const cleanBundle = result.sources!.clean!;

      expect(candidateBundle.hash).toBe(result.binding.sourceHash);
      expect(cleanBundle.hash).toBe(result.binding.cleanSourceHash);
      expect(candidateBundle.files.length).toBeGreaterThan(0);
      expect(candidateBundle.files.some(f => f.path.includes('order-engine'))).toBe(true);

      // Verify that reopening challenge from storage retains the exact source bundle
      const saved = await readChallenges(record.id, findingId, dir);
      expect(saved.current?.sources?.candidate?.hash).toBe(result.binding.sourceHash);
      expect(saved.current?.sources?.clean?.hash).toBe(result.binding.cleanSourceHash);
    });

    it('honestly degrades with missing-source notice for legacy records without recorded source', () => {
      const container = new MockElement('div');
      renderSourceViewer(container as unknown as HTMLElement, undefined);
      expect(container.allText()).toContain('Source code snapshot not recorded for this challenge attempt');
    });

    it('rejects code drift when disk source has drifted from recorded provenance', () => {
      const record = {
        id: 'run-test',
        status: 'completed',
        sourceHash: 'diverged-source-hash',
        contextAudit: {
          contractHash: 'fake-contract',
          cleanSourceHash: 'fake-clean',
        },
        experiments: [],
        findings: [{
          id: 'f1',
          experimentIndex: 0,
          reproduced: true,
          cleanControlPassed: true,
          sourceHash: 'diverged-source-hash',
          violation: { invariant: 'any' },
        }],
      } as any;

      expect(() => validateChallengePreconditions(record, 'f1')).toThrow();
    });
  });

  describe('Invariant 1: Truth comes from execution', () => {
    it('does not claim reproduction if candidate, replay, or clean are absent, mismatched or failed', async () => {
      const { dir, record, findingId } = await setup();
      const adapter = resolveAdapter('synthetic-trading');
      const execute = adapter.executeExperiment;

      // Mock clean to fail on the challenge variant only (not during preflight)
      vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
        const res = execute(exp, variant);
        if (variant === 'clean' && exp.hypothesis.startsWith('challenge-variant')) {
          res.violations = [{ id: 'cv1', invariant: record.findings[0]!.violation.invariant, message: 'clean violation', step: 1, evidence: {} }];
        }
        return res;
      });

      const result = await challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport: fakeTransport(record).transport,
      });

      expect(result.status).toBe('completed');
      const variant = result.variants[0]!;
      expect(variant.cleanStatus).toBe('failed');
      expect(variant.reproduced).toBe(false);
    });
  });

  describe('Invariant 4: Selection and cancellation stop obsolete work and timers', () => {
    it('cancellation between deterministic executions halts further work and saves partial stage checkpoint', async () => {
      const { dir, record, findingId } = await setup();
      const adapter = resolveAdapter('synthetic-trading');
      const execute = adapter.executeExperiment;
      const controller = new AbortController();
      let executions = 0;

      vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
        const res = execute(exp, variant);
        if (exp.hypothesis.startsWith('challenge-variant') && ++executions === 1) {
          // Abort right after first candidate execution
          controller.abort();
        }
        return res;
      });

      const result = await challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport: fakeTransport(record, 2).transport,
        signal: controller.signal,
      });

      expect(result.status).toBe('cancelled');
      expect(result.stage?.stage).toBe('terminal');
      expect(result.stage?.detail).toContain('cancelled');
      expect(result.variants.length).toBe(1);
      expect(result.variants[0]!.candidate).toBeDefined();

      const saved = await readChallenges(record.id, findingId, dir);
      expect(saved.latestAttempt?.status).toBe('cancelled');
      expect(saved.latestAttempt?.stage?.stage).toBe('terminal');
    });

    it('stopPlayback pauses timer and prevents further step increments', () => {
      const state: VerificationViewState = {
        selectedVariantIndex: 0,
        selectedSourceTarget: 'candidate',
        selectedExecutionKind: 'candidate',
        playbackIndex: 2,
        isPlaying: true,
        playbackTimer: setInterval(() => {}, 1000),
      };

      stopPlayback(state);
      expect(state.isPlaying).toBe(false);
      expect(state.playbackTimer).toBeUndefined();
    });
  });

  describe('Invariant 5: Attempts remain distinct and active running attempt is prominent', () => {
    it('preserves prior completed evidence when a subsequent attempt is running or fails', async () => {
      const { dir, record, findingId } = await setup();

      // 1. First completed challenge
      const first = await challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport: fakeTransport(record).transport,
      });
      expect(first.status).toBe('completed');

      // 2. Start second attempt and hold it
      const entered = deferred();
      const release = deferred();
      const transport = {
        generate: async () => {
          entered.resolve();
          await release.promise;
          throw new Error('Second attempt failed intentionally');
        },
      };

      const secondPromise = challengeFinding(record.id, findingId, {
        runsDir: dir,
        transport,
      });
      await entered.promise;

      // 3. Inspect storage during in-flight second attempt
      const inFlightSaved = await readChallenges(record.id, findingId, dir);
      expect(inFlightSaved.current?.id).toBe(first.id);
      expect(inFlightSaved.current?.status).toBe('completed');
      expect(inFlightSaved.latestAttempt?.status).toBe('running');
      expect(inFlightSaved.latestAttempt?.id).not.toBe(first.id);

      // 4. Release and fail second attempt
      release.resolve();
      const second = await secondPromise;
      expect(second.status).toBe('failed');

      // 5. Inspect storage after failed second attempt
      const afterSaved = await readChallenges(record.id, findingId, dir);
      expect(afterSaved.current?.id).toBe(first.id);
      expect(afterSaved.current?.status).toBe('completed');
      expect(afterSaved.latestAttempt?.id).toBe(second.id);
      expect(afterSaved.latestAttempt?.status).toBe('failed');
    });

    it('renders the active running attempt prominently without displaying old success as active result', () => {
      const completedRecord: ChallengeRecord = {
        schemaVersion: 1,
        id: 'completed-1',
        binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z',
        status: 'completed',
        variants: [{ proposedChange: 'c1', experiment: { hypothesis: 'h1', expectedInvariant: 'credit-limit', steps: [] }, changes: [], candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [], replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [] }],
        requests: [],
        interpretation: { status: 'available', text: 'Old success' },
      };

      const runningAttempt: ChallengeRecord = {
        schemaVersion: 1,
        id: 'running-2',
        binding: completedRecord.binding,
        startedAt: '2026-11-01T13:00:00Z',
        status: 'running',
        stage: { stage: 'candidate', variantIndex: 0, totalVariants: 1, detail: 'Variation 1 executing candidate…', updatedAt: '2026-11-01T13:00:05Z' },
        variants: [],
        requests: [],
        interpretation: { status: 'pending' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h',
        runRevision: '1',
        available: true,
        inFlight: true,
        stale: false,
        current: completedRecord,
        latestAttempt: runningAttempt,
      };

      const host = new MockElement('div');
      renderWatchVerificationView(host as unknown as HTMLElement, view, () => {});
      const text = host.allText();

      // Must show the active in-progress status
      expect(text).toContain('Active challenge in progress · Variation 1 executing candidate');
      // Must NOT show old completed success as the active running attempt's result
      expect(text).not.toContain('Variation 1 · reproduced');
      // Must preserve and display prior completed challenge
      expect(text).toContain('Saved challenge completed-1');
    });
  });

  describe('Invariant 6: Saved trace playback maps to recorded actions and operates deterministically', () => {
    it('steps through trace entries and synchronizes step highlighting in Column 1 without calls to model/code', () => {
      const record: ChallengeRecord = {
        schemaVersion: 1,
        id: 'repro-1',
        binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z',
        status: 'completed',
        variants: [{
          proposedChange: 'change step 2',
          experiment: {
            hypothesis: 'test-h',
            expectedInvariant: 'credit-limit',
            steps: [
              { op: 'send', id: 'm1', to: 'gw', payload: { action: 'order' } },
              { op: 'advance', ticks: 3 },
              { op: 'deliver', messageId: 'm1' },
            ],
          },
          changes: [{ step: 2, before: { op: 'advance', ticks: 1 }, after: { op: 'advance', ticks: 3 } }],
          candidate: {
            schemaVersion: 1,
            sourceHash: 's',
            experiment: { hypothesis: 'test-h', expectedInvariant: 'credit-limit', steps: [] },
            valid: true,
            executionComplete: true,
            violations: [{ id: 'v1', invariant: 'credit-limit', message: 'limit exceeded', step: 2, evidence: {} }],
            rejections: [],
            trace: [
              { step: 0, time: 10, action: 'send', outcome: 'scheduled', state: { orderCount: 1 } },
              { step: 1, time: 40, action: 'advance', outcome: 'processed', state: { ticks: 3 } },
              { step: 2, time: 50, action: 'deliver', outcome: 'violation', state: { credit: 999 } },
            ],
          },
          candidateStatus: 'completed',
          sameInvariant: 'observed',
          otherInvariants: [],
          replayStatus: 'matched',
          replayMismatches: [],
          cleanStatus: 'passed',
          reproduced: true,
          errors: [],
        }],
        requests: [],
        interpretation: { status: 'available', text: 'Hypothesis only' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h',
        runRevision: '1',
        available: true,
        inFlight: false,
        stale: false,
        current: record,
        latestAttempt: record,
      };

      const container = new MockElement('div');
      const state = getOrCreateViewState(container as unknown as HTMLElement);
      state.playbackIndex = 1; // At trace entry 2 (Action step 2)

      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      // Verify Column 1 highlights step 2
      const stepItems = container.querySelectorAll('.step-item');
      expect(stepItems.length).toBe(3);
      expect(stepItems[1]!.className).toContain('step-item-active');
      expect(stepItems[0]!.className).not.toContain('step-item-active');

      // Verify Column 3 shows entry details for step 2
      const text = container.allText();
      expect(text).toContain('Entry #2 · Action Step 2');
      expect(text).toContain('advance');
    });

    it('handles empty traces gracefully', () => {
      const record: ChallengeRecord = {
        schemaVersion: 1,
        id: 'empty-trace-record',
        binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z',
        status: 'completed',
        variants: [{
          proposedChange: 'change',
          experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'drain' }] },
          changes: [],
          candidate: {
            schemaVersion: 1,
            sourceHash: 's',
            experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] },
            valid: true,
            executionComplete: true,
            violations: [],
            rejections: [],
            trace: [],
          },
          candidateStatus: 'completed',
          sameInvariant: 'absent',
          otherInvariants: [],
          replayStatus: 'matched',
          replayMismatches: [],
          cleanStatus: 'passed',
          reproduced: false,
          errors: [],
        }],
        requests: [],
        interpretation: { status: 'available', text: 'Empty' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h',
        runRevision: '1',
        available: true,
        inFlight: false,
        stale: false,
        current: record,
        latestAttempt: record,
      };

      const container = new MockElement('div');
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});
      expect(container.allText()).toContain('Recorded trace is empty or unavailable');
    });
  });

  describe('Invariant 7: Safe content rendering and DOM security', () => {
    it('safely renders untrusted text in interpretation, source code, and payload without executing script tags', () => {
      const hostileString = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
      const record: ChallengeRecord = {
        schemaVersion: 1,
        id: 'hostile-content-attempt',
        binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z',
        status: 'completed',
        sources: {
          candidate: {
            hash: 's',
            files: [{ path: 'order-engine.ts', content: `// ${hostileString}\nexport function test() { return "${hostileString}"; }` }],
          },
        },
        variants: [{
          proposedChange: hostileString,
          experiment: { hypothesis: hostileString, expectedInvariant: 'credit-limit', steps: [{ op: 'send', id: 'h1', to: 'gw', payload: { malicious: hostileString } }] },
          changes: [],
          candidate: {
            schemaVersion: 1,
            sourceHash: 's',
            experiment: { hypothesis: hostileString, expectedInvariant: 'credit-limit', steps: [] },
            valid: true,
            executionComplete: true,
            violations: [{ id: 'v1', invariant: 'credit-limit', message: hostileString, step: 1, evidence: {} }],
            rejections: [],
            trace: [{ step: 1, time: 1, action: 'send', payload: { mal: hostileString }, outcome: hostileString, state: { key: hostileString } }],
          },
          candidateStatus: 'completed',
          sameInvariant: 'observed',
          otherInvariants: [],
          replayStatus: 'matched',
          replayMismatches: [],
          cleanStatus: 'passed',
          reproduced: true,
          errors: [],
        }],
        requests: [],
        interpretation: { status: 'available', text: hostileString },
      };

      const view: ChallengeView = {
        evidenceHash: 'h',
        runRevision: '1',
        available: true,
        inFlight: false,
        stale: false,
        current: record,
        latestAttempt: record,
      };

      const container = new MockElement('div');
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      // Verify that no <script> or <img> DOM elements were created
      const allTags = container.allTags();
      expect(allTags).not.toContain('script');
      expect(allTags).not.toContain('img');

      // Verify text is present as safe text
      const allText = container.allText();
      expect(allText).toContain(hostileString);
    });
  });

  describe('Watch Verification Consolidated Repair Tests: 8 Concrete Findings & Primary Observations', () => {

    it.each(['candidate', 'replay', 'clean'] as const)('does not give a completion tick to a failed %s outcome or hide later recorded checks', async kind => {
      const { dir, record, findingId } = await setup();
      const attempt = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record, 2).transport });
      const variant = attempt.variants[0]!;
      if (kind === 'candidate') variant.candidateStatus = 'invalid-or-incomplete';
      if (kind === 'replay') variant.replayStatus = 'mismatch';
      if (kind === 'clean') variant.cleanStatus = 'failed';
      const stages = deriveStageStates(attempt, false);
      expect(stages.find(s => s.name === kind)?.status).toBe('failed');
      if (kind !== 'clean') expect(stages.find(s => s.name === 'clean')?.status).toBe('completed');
    });

    it('does not count one completed variation as all planned variations after cancellation', async () => {
      const { dir, record, findingId } = await setup();
      const attempt = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record, 2).transport });
      attempt.status = 'cancelled';
      attempt.variants = attempt.variants.slice(0, 1);
      attempt.stage = { stage: 'terminal', totalVariants: 2, variantIndex: 1, updatedAt: new Date().toISOString() };
      const stages = deriveStageStates(attempt, false);
      for (const kind of ['candidate', 'replay', 'clean']) {
        expect(stages.find(s => s.name === kind)?.status).toBe('cancelled');
      }
    });

    it('Finding 1: derives stage truth across proposal failure, cancellation, partial execution, and skipped interpretation', () => {
      // 1. Proposal failure
      const proposalFailRecord: ChallengeRecord = {
        schemaVersion: 1, id: 'fail-att', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'failed', error: 'Proposal rejected',
        variants: [], requests: [], interpretation: { status: 'pending' },
      };
      const stagesFail = deriveStageStates(proposalFailRecord, false);
      expect(stagesFail[0]!.status).toBe('failed');
      expect(stagesFail[0]!.display).toBe('✗ 1. Proposal failed');
      expect(stagesFail[1]!.status).toBe('skipped');
      expect(stagesFail[1]!.display).toBe('- 2. Candidate execution skipped');
      expect(stagesFail[2]!.status).toBe('skipped');
      expect(stagesFail[3]!.status).toBe('skipped');
      expect(stagesFail[4]!.status).toBe('skipped');
      expect(stagesFail[5]!.status).toBe('failed');
      expect(stagesFail.every(s => !s.display.startsWith('✓'))).toBe(true);

      // 2. Proposal cancellation
      const cancelProposalRecord: ChallengeRecord = {
        ...proposalFailRecord, id: 'cancel-att', status: 'cancelled', error: 'Cancelled',
      };
      const stagesCancel = deriveStageStates(cancelProposalRecord, false);
      expect(stagesCancel[0]!.status).toBe('cancelled');
      expect(stagesCancel[0]!.display).toBe('⊘ 1. Proposal cancelled');
      expect(stagesCancel[1]!.status).toBe('skipped');
      expect(stagesCancel[5]!.status).toBe('cancelled');

      // 3. Partial execution: candidate completed, cancelled during replay
      const partialRecord: ChallengeRecord = {
        schemaVersion: 1, id: 'part-att', binding: proposalFailRecord.binding,
        startedAt: '2026-11-01T12:00:00Z', status: 'cancelled',
        stage: { stage: 'replay', updatedAt: '2026-11-01T12:01:00Z' },
        variants: [{
          proposedChange: 'p',
          experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'drain' }] },
          changes: [],
          candidate: { schemaVersion: 1, sourceHash: 's', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] }, valid: true, executionComplete: true, violations: [], rejections: [], trace: [] },
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [],
          replayStatus: 'unavailable', replayMismatches: [], cleanStatus: 'unavailable', reproduced: false, errors: [],
        }],
        requests: [], interpretation: { status: 'cancelled' },
      };
      const stagesPartial = deriveStageStates(partialRecord, false);
      expect(stagesPartial[0]!.status).toBe('completed');
      expect(stagesPartial[0]!.display).toBe('✓ 1. Muse proposed');
      expect(stagesPartial[1]!.status).toBe('completed');
      expect(stagesPartial[1]!.display).toBe('✓ 2. Candidate execution');
      expect(stagesPartial[2]!.status).toBe('cancelled');
      expect(stagesPartial[2]!.display).toBe('⊘ 3. Replay verification cancelled');
      expect(stagesPartial[3]!.status).toBe('skipped');
      expect(stagesPartial[4]!.status).toBe('skipped');
      expect(stagesPartial[5]!.status).toBe('cancelled');

      // 4. Completed challenge with interpretation not requested or unavailable
      const completedSkipInterp: ChallengeRecord = {
        ...partialRecord, status: 'completed', stage: { stage: 'terminal', updatedAt: '2026-11-01T12:02:00Z' },
        variants: [{
          ...partialRecord.variants[0]!,
          replay: { schemaVersion: 1, sourceHash: 's', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] }, valid: true, executionComplete: true, violations: [], rejections: [], trace: [] },
          replayStatus: 'matched',
          clean: { schemaVersion: 1, sourceHash: 'c', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] }, valid: true, executionComplete: true, violations: [], rejections: [], trace: [] },
          cleanStatus: 'passed',
        }],
        interpretation: { status: 'not-requested' },
      };
      const stagesSkipInterp = deriveStageStates(completedSkipInterp, false);
      expect(stagesSkipInterp[4]!.status).toBe('skipped');
      expect(stagesSkipInterp[4]!.display).toBe('- 5. Interpretation skipped');
      expect(stagesSkipInterp[4]!.display).not.toContain('✓');

      // 5. Interpretation unavailable
      const completedUnavailInterp: ChallengeRecord = {
        ...completedSkipInterp,
        interpretation: { status: 'unavailable', error: 'Quota exceeded' },
      };
      const stagesUnavail = deriveStageStates(completedUnavailInterp, false);
      expect(stagesUnavail[4]!.status).toBe('failed');
      expect(stagesUnavail[4]!.display).toBe('✗ 5. Interpretation unavailable');
      expect(stagesUnavail[4]!.display).not.toContain('✓');
    });

    it('Finding 2: keeps active progress distinct from historical inspection and labels each truthfully', () => {
      const priorAttempt: ChallengeRecord = {
        schemaVersion: 1, id: 'prior-success-1', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T10:00:00Z', status: 'completed',
        variants: [{
          proposedChange: 'p', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'drain' }] }, changes: [],
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [], replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [],
        }],
        requests: [], interpretation: { status: 'available', text: 'Old success' },
      };

      const runningAttempt: ChallengeRecord = {
        schemaVersion: 1, id: 'running-attempt-2', binding: priorAttempt.binding,
        startedAt: '2026-11-01T11:00:00Z', status: 'running',
        stage: { stage: 'candidate', detail: 'Running candidate execution…', updatedAt: '2026-11-01T11:01:00Z' },
        variants: [], requests: [], interpretation: { status: 'pending' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h', runRevision: '1', available: true, inFlight: true, stale: false,
        current: priorAttempt,
        latestAttempt: runningAttempt,
      };

      const container = new MockElement('div');
      const state = getOrCreateViewState(container as unknown as HTMLElement);

      // Default when inFlight: active running attempt is prominent
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});
      let text = container.allText();
      expect(text).toContain('Active challenge in progress · Running candidate execution…');

      // User manually selects the prior completed attempt
      state.selectedAttemptId = priorAttempt.id;
      container.replaceChildren();
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});
      text = container.allText();
      // Historical attempt must NOT display as "Active challenge in progress"
      expect(text).not.toContain('Active challenge in progress · Running candidate execution…');
      expect(text).toContain(`Saved challenge ${priorAttempt.id} · completed · ${priorAttempt.startedAt}`);

      // When another new generation starts with inFlight, state resets to prominent active progress
      const newRunningAttempt: ChallengeRecord = {
        ...runningAttempt, id: 'running-attempt-3',
        stage: { stage: 'proposal', detail: 'New Muse proposal in progress…' },
      };
      const updatedView: ChallengeView = {
        ...view,
        latestAttempt: newRunningAttempt,
      };
      container.replaceChildren();
      renderWatchVerificationView(container as unknown as HTMLElement, updatedView, () => {});
      text = container.allText();
      expect(text).toContain('Active challenge in progress · New Muse proposal in progress…');
    });

    it('Finding 3: owns playback by evidence identity, prevents timer increments after cleanup, and handles transitions', () => {
      vi.useFakeTimers();
      const container = new MockElement('div');
      const state = getOrCreateViewState(container as unknown as HTMLElement);

      const record1: ChallengeRecord = {
        schemaVersion: 1, id: 'rec-1', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h1', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'completed',
        variants: [{
          proposedChange: 'c', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'drain' }] }, changes: [],
          candidate: { schemaVersion: 1, sourceHash: 's', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] }, valid: true, executionComplete: true, violations: [], rejections: [], trace: [
            { step: 0, time: 1, action: 'advance', outcome: 'ok' },
            { step: 0, time: 2, action: 'advance', outcome: 'ok' },
            { step: 0, time: 3, action: 'advance', outcome: 'ok' },
          ] },
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [], replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [],
        }],
        requests: [], interpretation: { status: 'available' },
      };

      const view1: ChallengeView = {
        evidenceHash: 'h1', runRevision: '1', available: true, inFlight: false, stale: false,
        current: record1, latestAttempt: record1,
      };

      renderWatchVerificationView(container as unknown as HTMLElement, view1, () => {});

      // Simulate Play
      const btnPlay = container.querySelectorAll('button').find(b => b.textContent === 'Play');
      expect(btnPlay).toBeDefined();
      btnPlay!.dispatchEvent('click');
      expect(state.isPlaying).toBe(true);

      // Advance one tick
      vi.advanceTimersByTime(600);
      expect(state.playbackIndex).toBe(1);

      // Switch selection to different run / finding evidence with shorter trace (1 entry)
      const record2: ChallengeRecord = {
        ...record1, id: 'rec-2', binding: { ...record1.binding, findingId: 'f2', evidenceHash: 'h2' },
        variants: [{
          ...record1.variants[0]!,
          candidate: { ...record1.variants[0]!.candidate!, trace: [{ step: 0, time: 1, action: 'advance', outcome: 'ok' }] },
        }],
      };
      const view2: ChallengeView = {
        evidenceHash: 'h2', runRevision: '1', available: true, inFlight: false, stale: false,
        current: record2, latestAttempt: record2,
      };

      renderWatchVerificationView(container as unknown as HTMLElement, view2, () => {});

      // Verify playback was stopped on identity change and index reset to 0
      expect(state.isPlaying).toBe(false);
      expect(state.playbackIndex).toBe(0);

      // Verify timers do not continue incrementing in the background
      vi.advanceTimersByTime(1200);
      expect(state.playbackIndex).toBe(0);

      // Cleanup verification view explicitly
      cleanupVerificationView(container as unknown as HTMLElement);
      expect(state.isPlaying).toBe(false);
      expect(state.playbackTimer).toBeUndefined();

      vi.useRealTimers();
    });

    it('Finding 4: uses real zero-based trace convention, highlights EXACTLY one action, and never shows Action Step 0', () => {
      const record: ChallengeRecord = {
        schemaVersion: 1, id: 'rec-zero-trace', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'completed',
        variants: [{
          proposedChange: 'change',
          experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [
            { op: 'send', id: 'm1', to: 'gw', payload: {} }, // Action index 0 -> Step #1
            { op: 'advance', ticks: 1 },                      // Action index 1 -> Step #2
            { op: 'deliver', messageId: 'm1' },               // Action index 2 -> Step #3
          ] },
          changes: [],
          candidate: {
            schemaVersion: 1, sourceHash: 's', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] },
            valid: true, executionComplete: true, violations: [], rejections: [],
            trace: [
              // Real zero-based trace: step 0 points to action index 0
              { step: 0, time: 10, action: 'send', outcome: 'scheduled' },
              { step: 0, time: 15, action: 'send', outcome: 'dispatched' },
              { step: 1, time: 20, action: 'advance', outcome: 'completed' },
            ],
          },
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [],
          replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [],
        }],
        requests: [], interpretation: { status: 'available' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h', runRevision: '1', available: true, inFlight: false, stale: false,
        current: record, latestAttempt: record,
      };

      const container = new MockElement('div');
      const state = getOrCreateViewState(container as unknown as HTMLElement);

      // 1. Playback at Entry 1 (trace index 0, step 0 -> Action #1)
      state.playbackIndex = 0;
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      let stepItems = container.querySelectorAll('.step-item');
      let activeItems = stepItems.filter(item => item.className.includes('step-item-active'));
      expect(activeItems.length).toBe(1);
      expect(stepItems[0]!.className).toContain('step-item-active');
      expect(stepItems[1]!.className).not.toContain('step-item-active');
      expect(stepItems[2]!.className).not.toContain('step-item-active');

      // Inspector displays Action Step 1 (never Action Step 0!)
      expect(container.allText()).toContain('Entry #1 · Action Step 1');
      expect(container.allText()).not.toContain('Action Step 0');

      // 2. Playback at Entry 2 (trace index 1, also step 0 -> still Action #1)
      state.playbackIndex = 1;
      container.replaceChildren();
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});
      stepItems = container.querySelectorAll('.step-item');
      activeItems = stepItems.filter(item => item.className.includes('step-item-active'));
      expect(activeItems.length).toBe(1);
      expect(stepItems[0]!.className).toContain('step-item-active');

      // 3. Playback at Entry 3 (trace index 2, step 1 -> Action #2)
      state.playbackIndex = 2;
      container.replaceChildren();
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});
      stepItems = container.querySelectorAll('.step-item');
      activeItems = stepItems.filter(item => item.className.includes('step-item-active'));
      expect(activeItems.length).toBe(1);
      expect(stepItems[1]!.className).toContain('step-item-active');
      expect(stepItems[0]!.className).not.toContain('step-item-active');
      expect(container.allText()).toContain('Entry #3 · Action Step 2');
    });

    it('Finding 5: validates background progress identity, matching hash and revision, rejecting mismatched poll results', async () => {
      const { dir, record, findingId } = await setup();
      const view = await getChallengeView(record.id, findingId, dir);
      const calls: string[] = [];
      let pollViewToReturn: ChallengeView = structuredClone(view);
      const releasePost = deferred();
      const digest = vi.spyOn(crypto.subtle, 'digest');

      const session = new ChallengeSession(() => {}, async (url, init) => {
        calls.push(`${url} [${init?.method ?? 'GET'}]`);
        if (init?.method === 'POST') {
          await releasePost.promise;
          return reply({
            status: 'completed',
            binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision },
          });
        }
        return reply(pollViewToReturn);
      });
      sessions.push(session);

      session.select(record, findingId);
      await settled(session);
      expect(session.state).toBe('ready');
      expect(session.view).toEqual(view);
      expect(digest).toHaveBeenCalledTimes(1);

      // Start background generation
      const genPromise = session.generate();
      expect(session.state).toBe('generating');

      // 1. Background poll with mismatched evidenceHash is rejected
      pollViewToReturn = {
        ...view,
        evidenceHash: 'mismatched-external-hash',
        stage: { stage: 'candidate', detail: 'External run progress' },
      };
      // Trigger pollProgress directly via refresh or time
      await (session as any).pollProgress((session as any).seq);
      // View must NOT adopt the mismatched evidence
      expect(session.view?.evidenceHash).toBe(view.evidenceHash);

      // 2. Background poll with mismatched runRevision is rejected
      pollViewToReturn = {
        ...view,
        evidenceHash: view.evidenceHash,
        runRevision: 'drifted-revision-999',
        stage: { stage: 'clean', detail: 'Drifted revision progress' },
      };
      await (session as any).pollProgress((session as any).seq);
      expect(session.view?.runRevision).toBe(view.runRevision);

      // 3. Background poll matching evidenceHash AND expectedRunRevision is accepted
      pollViewToReturn = {
        ...view,
        evidenceHash: view.evidenceHash,
        runRevision: view.runRevision,
        stage: { stage: 'candidate', detail: 'Legitimate variation 1 progress' },
      };
      await (session as any).pollProgress((session as any).seq);
      expect(session.view?.stage?.detail).toBe('Legitimate variation 1 progress');

      // Release held POST
      releasePost.resolve();
      await genPromise;
      expect(session.state).toBe('ready');
      expect(digest).toHaveBeenCalledTimes(1);

      // A new selected record must compute its own identity and reject the old response.
      const changedRecord = structuredClone(record);
      changedRecord.findings[0]!.title += ' changed';
      session.select(changedRecord, findingId);
      await settled(session);
      expect(digest).toHaveBeenCalledTimes(2);
      expect(session.view).toBeNull();
      expect(session.canGenerate).toBe(false);
    });

    it('Finding 6: rechecks cancellation after stage persistence and avoids simulator call when aborted during save/lock wait', async () => {
      const { dir, record, findingId } = await setup();
      const adapter = resolveAdapter(record.contextAudit.adapterId ?? 'synthetic-trading');
      const executeSpy = vi.spyOn(adapter, 'executeExperiment');
      const controller = new AbortController();

      let candidateSaveEntered = false;
      let proposalCompleted = false;
      let candidateSaveCalls = 0;
      const originalGetRun = storage.getRun;
      vi.spyOn(storage, 'getRun').mockImplementation(async (runId, runsDir) => {
        const res = await originalGetRun(runId, runsDir);
        if (proposalCompleted) {
          candidateSaveCalls++;
          // Call 1 after proposal is assertCurrent. Call 2 is saveChallenge for candidate stage checkpoint!
          if (candidateSaveCalls === 2) {
            candidateSaveEntered = true;
            controller.abort(); // Abort DURING awaited stage checkpoint persistence
          }
        }
        return res;
      });

      const transport = {
        generate: async (system: string) => {
          if (system.includes('Propose bounded deterministic variations')) {
            proposalCompleted = true;
            return { content: proposalFor(record, 1), usage };
          }
          throw new Error('Unexpected call');
        },
      };

      const result = await challengeFinding(record.id, findingId, {
        runsDir: dir,
        signal: controller.signal,
        transport,
      });

      expect(candidateSaveEntered).toBe(true);
      expect(result.status).toBe('cancelled');
      // Critical invariant: executeExperiment was NOT called in the loop (only the 1 initial clean preflight check was made)
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalledWith(expect.anything(), record.variant);
      expect(result.stage?.detail).toContain('cancelled');
      expect(result.stage?.totalVariants).toBe(1);
      expect(result.stage?.variantIndex).toBe(0);
      expect(result.requests.length).toBeGreaterThan(0);
    });

    it('Finding 7: renders exact before and after action differences safely, preserving hostile text without execution', () => {
      const hostilePayload = '<script>alert("hostile-payload")</script>';
      const record: ChallengeRecord = {
        schemaVersion: 1, id: 'diff-rec', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'completed',
        variants: [{
          proposedChange: 'test diffs',
          experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'advance', ticks: 3 }] },
          changes: [
            { step: 1, before: { op: 'advance', ticks: 1 }, after: { op: 'advance', ticks: 3 } },
            { step: 2, after: { op: 'advance', ticks: 2 } },
            { step: 3, before: { op: 'send', id: 'm1', to: 'gw', payload: { data: hostilePayload } } },
          ],
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [], replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [],
        }],
        requests: [], interpretation: { status: 'available' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h', runRevision: '1', available: true, inFlight: false, stale: false,
        current: record, latestAttempt: record,
      };

      const container = new MockElement('div');
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      const text = container.allText();
      // Changed values must be inspectable
      expect(text).toContain('{"op":"advance","ticks":1}');
      expect(text).toContain('{"op":"advance","ticks":3}');
      expect(text).toContain('{"op":"advance","ticks":2}');
      // Hostile payload is safely displayed as text (JSON stringified)
      expect(text).toContain('hostile-payload');
      expect(text).toContain('<script>alert(\\"hostile-payload\\")</script>');
      // No actual <script> tag created
      expect(container.allTags()).not.toContain('script');
    });

    it('Finding 8: renders retained footer and request accounting even without variations on proposal failure', () => {
      const failedProposalRecord: ChallengeRecord = {
        schemaVersion: 1, id: 'failed-prop-rec', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'failed', error: 'Invalid proposal JSON envelope from Muse',
        variants: [], // 0 variants!
        requests: [{
          phase: 'proposal', model: 'offline/mock', status: 'failed',
          requestSent: true, usage: { inputTokens: 120, outputTokens: 45, estimatedCostUsd: 0.001 },
          usageKnown: true, error: 'JSON parse error at position 4',
        }],
        proposalResponse: { text: '{ malformed proposal: true }', bytes: 27, truncated: false },
        interpretation: { status: 'unavailable', error: 'Proposal failed' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h', runRevision: '1', available: true, inFlight: false, stale: false,
        current: null, latestAttempt: failedProposalRecord,
      };

      const container = new MockElement('div');
      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      const text = container.allText();
      // 1. Shows error notice
      expect(text).toContain('Invalid proposal JSON envelope from Muse');
      // 2. Retains footer diagnostics and accounting
      expect(text).toContain('Challenge model requests and reported usage');
      expect(text).toContain('JSON parse error at position 4');
      expect(text).toContain('offline/mock');
      expect(text).toContain('Model proposal response (untrusted text)');
      expect(text).toContain('{ malformed proposal: true }');
    });

    it('Primary Observation 1: preserves Play button and controls without destroying DOM or recreating source viewer on playback stepping', () => {
      const record: ChallengeRecord = {
        schemaVersion: 1, id: 'rec-playback-focus', binding: { runId: 'r1', findingId: 'f1', evidenceHash: 'h', runRevision: '1', experimentPosition: 0, adapterId: 'synthetic-trading', target: 'candidate-a', invariant: 'credit-limit', sourceHash: 's', cleanSourceHash: 'c', contractHash: 'k', snapshotHash: null },
        startedAt: '2026-11-01T12:00:00Z', status: 'completed',
        sources: {
          candidate: { hash: 's', files: [{ path: 'trade.ts', content: 'export const x = 1;' }] },
        },
        variants: [{
          proposedChange: 'change', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [{ op: 'advance', ticks: 1 }, { op: 'advance', ticks: 2 }] },
          changes: [],
          candidate: {
            schemaVersion: 1, sourceHash: 's', experiment: { hypothesis: 'h', expectedInvariant: 'credit-limit', steps: [] },
            valid: true, executionComplete: true, violations: [], rejections: [],
            trace: [
              { step: 0, time: 10, action: 'advance', outcome: 'ok' },
              { step: 1, time: 20, action: 'advance', outcome: 'ok' },
            ],
          },
          candidateStatus: 'completed', sameInvariant: 'observed', otherInvariants: [], replayStatus: 'matched', replayMismatches: [], cleanStatus: 'passed', reproduced: true, errors: [],
        }],
        requests: [], interpretation: { status: 'available' },
      };

      const view: ChallengeView = {
        evidenceHash: 'h', runRevision: '1', available: true, inFlight: false, stale: false,
        current: record, latestAttempt: record,
      };

      const container = new MockElement('div');
      const state = getOrCreateViewState(container as unknown as HTMLElement);

      renderWatchVerificationView(container as unknown as HTMLElement, view, () => {});

      const btnPlay = container.querySelectorAll('button').find(b => b.textContent === 'Play')!;
      const btnNext = container.querySelectorAll('button').find(b => b.textContent === 'Next >')!;
      const viewerBefore = container.querySelector('.source-code-viewer');
      expect(viewerBefore).toBeDefined();

      // Click Next >: steps forward
      btnNext.dispatchEvent('click');
      expect(state.playbackIndex).toBe(1);

      // Verify source viewer DOM element was NOT recreated or replaced
      const viewerAfterNext = container.querySelector('.source-code-viewer');
      expect(viewerAfterNext).toBe(viewerBefore);

      // Click Play: toggles to Pause in place
      btnPlay.dispatchEvent('click');
      expect(state.isPlaying).toBe(true);
      expect(btnPlay.textContent).toBe('Pause');

      // Click Pause: toggles back to Play in place
      btnPlay.dispatchEvent('click');
      expect(state.isPlaying).toBe(false);
      expect(btnPlay.textContent).toBe('Play');
      expect(container.querySelector('.source-code-viewer')).toBe(viewerBefore);
    });

  });

});
