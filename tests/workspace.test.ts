import { describe, expect, it } from 'vitest';
import {
  effectiveAdapterId,
  executableCheckCount,
  groupRunsByRevision,
  hasRunDetail,
  inspectionScope,
  launchBlockedReason,
  partitionRuns,
  runOutcomeLabel,
  shouldAutoRenderActiveRecord,
  shouldClearInspectionOnSelection,
  stopControlState,
  tradingContractVisible,
  WORKSPACE_VIEWS,
} from '../src/web/workspace.ts';
import type { RunSummary } from '../src/storage.ts';

function run(id: string, brief?: { id: string; revision: number }): RunSummary {
  return {
    id, provider: 'mock', model: 'mock-runner', mode: 'mock', variant: 'candidate-a',
    status: 'completed', startedAt: '2026-10-26T00:00:00.000Z', findingsCount: 0,
    experimentsCount: 1, sourceHash: 'src',
    ...(brief ? { systemBrief: { id: brief.id, name: brief.id, revision: brief.revision, adapterId: 'synthetic-trading', hash: 'h' } } : {}),
  };
}

describe('system-scoped history', () => {
  it('scopes runs by pinned system and keeps legacy unassigned', () => {
    const runs = [
      run('run-trading-2', { id: 'trading-gateway', revision: 2 }),
      run('run-trading-1', { id: 'trading-gateway', revision: 1 }),
      run('run-payments-1', { id: 'payments', revision: 1 }),
      run('run-legacy-1'),
    ];
    const part = partitionRuns(runs, 'trading-gateway');
    expect(part.scoped.map(r => r.id)).toEqual(['run-trading-2', 'run-trading-1']);
    expect(part.other.map(r => r.id)).toEqual(['run-payments-1']);
    expect(part.legacy.map(r => r.id)).toEqual(['run-legacy-1']);
    // Selecting the other system must not absorb the legacy record.
    expect(partitionRuns(runs, 'payments').legacy.map(r => r.id)).toEqual(['run-legacy-1']);
  });

  it('groups by pinned revision so rev1 stays rev1 after profile moves to rev2', () => {
    const groups = groupRunsByRevision([
      run('run-a', { id: 'trading-gateway', revision: 1 }),
      run('run-b', { id: 'trading-gateway', revision: 2 }),
      run('run-c', { id: 'trading-gateway', revision: 1 }),
      run('run-legacy'),
    ]);
    expect(groups.map(g => g.revision)).toEqual([2, 1, null]);
    expect(groups[1]!.runs.map(r => r.id)).toEqual(['run-a', 'run-c']);
  });

  it('reports check availability only for the synthetic adapter, never as coverage', () => {
    expect(executableCheckCount('synthetic-trading', 10)).toBe(10);
    expect(executableCheckCount('unconfigured', 10)).toBe(0);
    expect(executableCheckCount(null, 10)).toBe(0);
  });

  it('never labels stopped or failed runs as a clean pass', () => {
    expect(runOutcomeLabel('completed')).toBe('Completed');
    expect(runOutcomeLabel('cancelled')).toContain('not a clean pass');
    expect(runOutcomeLabel('failed')).toContain('not a clean pass');
    expect(runOutcomeLabel('running')).toBe('Running');
  });
});

describe('workspace scoping of inspection and capabilities', () => {
  it('clears a non-active other-system or legacy inspection on selection, keeps the active run', () => {
    expect(shouldClearInspectionOnSelection({ recordId: 'a1', recordSystemId: 'delivery-qa', activeRecordId: null, selectedSystemId: 'payments-qa' })).toBe(true);
    expect(shouldClearInspectionOnSelection({ recordId: 'leg', recordSystemId: null, activeRecordId: null, selectedSystemId: 'payments-qa' })).toBe(true);
    expect(shouldClearInspectionOnSelection({ recordId: 'a1', recordSystemId: 'delivery-qa', activeRecordId: 'a1', selectedSystemId: 'payments-qa' })).toBe(false);
    expect(shouldClearInspectionOnSelection({ recordId: 'b1', recordSystemId: 'payments-qa', activeRecordId: null, selectedSystemId: 'payments-qa' })).toBe(false);
    expect(shouldClearInspectionOnSelection({ recordId: null, recordSystemId: null, activeRecordId: null, selectedSystemId: 'payments-qa' })).toBe(false);
  });
  it('does not auto-render an other-system or legacy active record, but allows explicit opening', () => {
    expect(shouldAutoRenderActiveRecord({ recordSystemId: 'delivery-qa', selectedSystemId: 'payments-qa', explicitlyOpened: false })).toBe(false);
    expect(shouldAutoRenderActiveRecord({ recordSystemId: null, selectedSystemId: 'payments-qa', explicitlyOpened: false })).toBe(false);
    expect(shouldAutoRenderActiveRecord({ recordSystemId: 'delivery-qa', selectedSystemId: 'payments-qa', explicitlyOpened: true })).toBe(true);
    expect(shouldAutoRenderActiveRecord({ recordSystemId: 'payments-qa', selectedSystemId: 'payments-qa', explicitlyOpened: false })).toBe(true);
    expect(inspectionScope(null, 'payments-qa')).toBe('legacy');
    expect(inspectionScope('delivery-qa', 'payments-qa')).toBe('other');
  });
  it('scopes the trading contract to the effective (draft-aware) adapter', () => {
    expect(effectiveAdapterId({ isDraftMode: false, hasUnsavedSystemEdits: true, draftAdapterId: 'unconfigured', savedAdapterId: 'synthetic-trading' })).toBe('unconfigured');
    expect(effectiveAdapterId({ isDraftMode: false, hasUnsavedSystemEdits: false, draftAdapterId: 'unconfigured', savedAdapterId: 'synthetic-trading' })).toBe('synthetic-trading');
    expect(tradingContractVisible('unconfigured')).toBe(false);
    expect(tradingContractVisible(null)).toBe(false);
    expect(tradingContractVisible('synthetic-trading')).toBe(true);
    expect(executableCheckCount(effectiveAdapterId({ isDraftMode: true, hasUnsavedSystemEdits: true, draftAdapterId: 'unconfigured', savedAdapterId: null }), 10)).toBe(0);
  });
  it('shows no run detail until a real record is opened', () => {
    expect(hasRunDetail(null)).toBe(false);
    expect(hasRunDetail(undefined)).toBe(false);
    expect(hasRunDetail('run-1')).toBe(true);
  });

  it('exposes the seven real workspace views', () => {
    expect(WORKSPACE_VIEWS).toEqual(['overview', 'brief', 'capabilities', 'prepare', 'investigations', 'findings', 'functional']);
  });

  it('blocks launch while starting, saving, or missing a selected system', () => {
    const ready = {
      isLaunchRequestPending: false, isInvestigationActive: false, isSystemSavePending: false,
      isDraftMode: false, hasUnsavedSystemEdits: false, hasSelectedSystem: true,
      selectedAdapterId: 'synthetic-trading',
    };
    expect(launchBlockedReason({ ...ready, isLaunchRequestPending: true })).toMatch(/STARTING/);
    expect(launchBlockedReason({ ...ready, isSystemSavePending: true })).toMatch(/SAVING/);
    expect(launchBlockedReason({ ...ready, hasSelectedSystem: false, selectedAdapterId: null })).toMatch(/SELECT/);
  });
});

describe('global stop control state', () => {
  it('is visible and enabled while running or pending, disabled while stopping, hidden when terminal', () => {
    expect(stopControlState({ isStartPending: false, isInvestigationActive: true, serverStatus: 'running' })).toEqual({ visible: true, enabled: true, label: 'Stop investigation' });
    expect(stopControlState({ isStartPending: true, isInvestigationActive: false, serverStatus: 'starting' }).label).toBe('Stop pending start');
    expect(stopControlState({ isStartPending: false, isInvestigationActive: true, serverStatus: 'stopping' })).toEqual({ visible: true, enabled: false, label: 'Stopping…' });
    expect(stopControlState({ isStartPending: false, isInvestigationActive: false, serverStatus: 'completed' }).visible).toBe(false);
    expect(stopControlState({ isStartPending: false, isInvestigationActive: false, serverStatus: 'cancelled' }).visible).toBe(false);
  });
});
