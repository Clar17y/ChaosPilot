import { describe, it, expect, vi } from 'vitest';
import {
  TargetApiController,
  targetApiBlockedReason,
  targetApiResultHtml,
  type TargetApiContext,
  type TargetApiViewState,
} from '../../src/web/target-api.ts';
import type { ApiJourneyRecord, ApiJourneySummary, Comparison } from '../../src/target-api/types.ts';

describe('UI/control integration does not cross contexts', () => {
  const readyContext: TargetApiContext = {
    systemId: 'trading-gateway',
    revision: 1,
    hasSelectedSystem: true,
    isDraftMode: false,
    hasUnsavedSystemEdits: false,
    isSystemSavePending: false,
    selectedAdapterId: 'synthetic-trading',
    selectedVariant: 'clean',
    allowedVariants: ['clean', 'candidate-a'],
    snapshotState: 'ready',
    targetState: 'ready',
  };

  it('computes blockedReason correctly across context states', () => {
    expect(targetApiBlockedReason(null)).toMatch(/select a saved system/i);

    expect(targetApiBlockedReason({ ...readyContext, isDraftMode: true })).toMatch(/save system profile/i);

    expect(targetApiBlockedReason({ ...readyContext, hasUnsavedSystemEdits: true })).toMatch(/save pending profile edits/i);

    expect(targetApiBlockedReason({ ...readyContext, isSystemSavePending: true })).toMatch(/save pending profile edits/i);

    expect(targetApiBlockedReason({ ...readyContext, selectedAdapterId: 'inventory-reservation' })).toMatch(
      /only support synthetic-trading/i,
    );

    expect(targetApiBlockedReason({ ...readyContext, snapshotState: 'missing' })).toMatch(/snapshot not ready/i);

    expect(targetApiBlockedReason({ ...readyContext, selectedVariant: null })).toMatch(/select a valid target/i);

    expect(targetApiBlockedReason(readyContext)).toBeNull();

    expect(targetApiBlockedReason(readyContext, true)).toMatch(/in progress/i);
  });

  it('discards stale async response if context changes before completion', async () => {
    let resolveRun: (val: any) => void = () => {};
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/target-api/runs') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url === '/api/target-api/run') {
        return new Promise((resolve) => {
          resolveRun = () =>
            resolve({
              ok: true,
              status: 201,
              json: () =>
                Promise.resolve({
                  id: 'apij_stale',
                  variant: 'clean',
                  systemSnapshot: { brief: { id: 'trading-gateway', revision: 1 } },
                  journeys: [],
                }),
            });
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const states: TargetApiViewState[] = [];
    const controller = new TargetApiController(fetchFn, (s) => states.push(structuredClone(s)));

    controller.setContext(readyContext);
    expect(controller.state.blockedReason).toBeNull();

    // Start run
    const runPromise = controller.run();
    expect(controller.state.pending).toBe(true);

    // Context changes while request is in flight: user switches to another system
    controller.setContext({
      ...readyContext,
      systemId: 'other-system',
    });

    // Now resolve the late run response
    resolveRun(null);
    await runPromise;

    // The late response must NOT overwrite state.record
    expect(controller.state.record).toBeNull();
    expect(controller.state.context?.systemId).toBe('other-system');
  });

  it('opens historical saved run read-only and scopes history to profile', async () => {
    const mockRuns: ApiJourneySummary[] = [
      {
        id: 'apij_1',
        startedAt: '2026-11-01T10:00:00Z',
        finishedAt: '2026-11-01T10:00:02Z',
        adapterId: 'synthetic-trading',
        variant: 'clean',
        systemBrief: { id: 'trading-gateway', name: 'Trading Gateway', revision: 1 },
        status: 'pass',
        journeyCount: 3,
      },
      {
        id: 'apij_2',
        startedAt: '2026-11-01T11:00:00Z',
        finishedAt: '2026-11-01T11:00:02Z',
        adapterId: 'synthetic-trading',
        variant: 'clean',
        systemBrief: { id: 'other-profile', name: 'Other', revision: 1 },
        status: 'pass',
        journeyCount: 3,
      },
    ];

    const mockRecord: Partial<ApiJourneyRecord> = {
      id: 'apij_1',
      systemSnapshot: { brief: { id: 'trading-gateway', revision: 1, name: 'Trading' } } as any,
      variant: 'clean',
      status: 'pass',
      journeys: [],
    };

    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/target-api/runs') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockRuns) });
      }
      if (url === '/api/target-api/runs/apij_1') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockRecord) });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const controller = new TargetApiController(fetchFn, () => {});
    controller.setContext(readyContext);
    await controller.loadHistory();

    // Scoped to 'trading-gateway'
    expect(controller.state.history).toHaveLength(1);
    expect(controller.state.history[0]?.id).toBe('apij_1');

    // Open run
    await controller.open('apij_1');
    expect(controller.state.record?.id).toBe('apij_1');
    expect(controller.state.pending).toBe(false);
  });

  it('renders target API HTML with comparison banner and escapes dangerous text', () => {
    const mockRecord: ApiJourneyRecord = {
      schemaVersion: 1,
      type: 'scripted-target-api',
      id: 'apij_test',
      startedAt: '2026-11-01T10:00:00Z',
      finishedAt: '2026-11-01T10:00:02Z',
      adapterId: 'synthetic-trading',
      variant: 'clean',
      systemSnapshot: { brief: { id: 'trading-gateway', name: 'Trading <Gateway>', revision: 1 } } as any,
      sourceHash: 'sha_src',
      transport: { version: 1, hash: 'sha_trans' },
      evaluator: { version: 1, hash: 'sha_eval' },
      contractHash: 'sha_contract',
      status: 'pass',
      integrity: 'sha_integrity',
      journeys: [
        {
          id: 'test-journey',
          instanceId: 'inst-1',
          endpoint: 'http://127.0.0.1:1234',
          exchanges: [
            {
              method: 'POST',
              path: '/orders',
              request: { kind: 'order' },
              status: 202,
              response: { status: 'queued' },
              elapsedMs: 5,
            },
          ],
          observation: null,
          assertions: [
            { id: '1.order', expected: 'OPEN', observed: 'OPEN', status: 'pass' },
          ],
          status: 'pass',
        },
      ],
    };

    const mockComparison: Comparison = {
      status: 'match',
      reasons: [],
      note: 'Verified semantic match',
      originalId: 'apij_orig',
      freshId: 'apij_test',
    };

    const html = targetApiResultHtml(mockRecord, mockComparison);
    expect(html).toContain('Trading &lt;Gateway&gt;');
    expect(html).toContain('Rerun comparison against apij_orig');
    expect(html).toContain('MATCH');
    expect(html).toContain('test-journey');
    expect(html).toContain('1.order');
    expect(html).toContain('OPEN');
    expect(html).toContain('target-api-payload-grid');
    expect(html).toContain('All business invariants and protocol assertions matched identically.');
  });

  it('renders honest banner summary for matching failed runs and blocked comparisons', () => {
    const failedRecord: ApiJourneyRecord = {
      schemaVersion: 1,
      type: 'scripted-target-api',
      id: 'apij_failed',
      startedAt: '2026-11-01T10:00:00Z',
      finishedAt: '2026-11-01T10:00:02Z',
      adapterId: 'synthetic-trading',
      variant: 'candidate-a',
      systemSnapshot: { brief: { id: 'trading-gateway', name: 'Trading Gateway', revision: 1 } } as any,
      sourceHash: 'sha_src',
      transport: { version: 1, hash: 'sha_trans' },
      evaluator: { version: 1, hash: 'sha_eval' },
      contractHash: 'sha_contract',
      status: 'fail',
      integrity: 'sha_integrity',
      journeys: [],
    };

    const failedMatch: Comparison = {
      status: 'match',
      reasons: [],
      note: 'Semantic rerun comparison identically reproduced the expected failure',
      originalId: 'apij_orig',
      freshId: 'apij_failed',
    };

    const failedHtml = targetApiResultHtml(failedRecord, failedMatch);
    expect(failedHtml).toContain('Both runs identically reproduced the expected failure.');
    expect(failedHtml).not.toContain('All business invariants and protocol assertions matched identically.');

    const blockedComparison: Comparison = {
      status: 'blocked',
      reasons: [],
      note: 'Semantic rerun comparison blocked',
      originalId: 'apij_orig',
      freshId: 'apij_failed',
    };

    const blockedHtml = targetApiResultHtml(failedRecord, blockedComparison);
    expect(blockedHtml).toContain('Semantic rerun comparison is blocked for this configuration.');
  });

  it('validates response context symmetrically in rerunAndCompare', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/target-api/compare') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              comparison: { status: 'match', reasons: [], note: 'note', originalId: 'apij_orig' },
              freshRecord: {
                id: 'apij_mismatched',
                variant: 'candidate-a', // Mismatched variant vs launch context 'clean'
                systemSnapshot: { brief: { id: 'trading-gateway', revision: 1 } },
                journeys: [],
              },
            }),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const controller = new TargetApiController(fetchFn, () => {});
    controller.setContext(readyContext);
    controller.state.record = {
      id: 'apij_orig',
      variant: 'clean',
      systemSnapshot: { brief: { id: 'trading-gateway', revision: 1 } },
    } as any;

    await controller.rerunAndCompare();

    expect(controller.state.error).toContain('Compare response identity does not match launch selection');
  });
});
