import { describe, expect, it } from 'vitest';
import {
  computeFindingReportHref,
  computeReportLinks,
  type ReportSessionKind,
} from '../src/web/report-links.ts';

describe('report-links helper state transitions', () => {
  it('returns disabled state with null hrefs when no run is opened', () => {
    const state = computeReportLinks(null, 'saved');
    expect(state.canAccess).toBe(false);
    expect(state.viewHref).toBeNull();
    expect(state.downloadHref).toBeNull();
  });

  it.each([
    'idle',
    'loading',
    'generating',
    'stale',
    'error',
    'unavailable',
  ] as ReportSessionKind[])(
    'disallows report access when session kind is %s',
    kind => {
      const state = computeReportLinks('run-1234', kind);
      expect(state.canAccess).toBe(false);
      expect(state.viewHref).toBeNull();
      expect(state.downloadHref).toBeNull();

      const findingHref = computeFindingReportHref('run-1234', 1, kind);
      expect(findingHref).toBeNull();
    },
  );

  it('generates valid discoverable URLs when a run has a saved report', () => {
    const runId = 'run-abc-789';
    const state = computeReportLinks(runId, 'saved');
    expect(state.canAccess).toBe(true);
    expect(state.viewHref).toBe('/api/runs/run-abc-789/explanation-report');
    expect(state.downloadHref).toBe('/api/runs/run-abc-789/explanation-report?download=1');
  });

  it('encodes special characters in runId safely', () => {
    const runId = 'run/test#1';
    const state = computeReportLinks(runId, 'saved');
    expect(state.canAccess).toBe(true);
    expect(state.viewHref).toBe('/api/runs/run%2Ftest%231/explanation-report');
    expect(state.downloadHref).toBe('/api/runs/run%2Ftest%231/explanation-report?download=1');
  });

  it('correctly updates URLs across run switches', () => {
    let state = computeReportLinks('run-first', 'saved');
    expect(state.viewHref).toBe('/api/runs/run-first/explanation-report');

    // Switched to a new run while loading status
    state = computeReportLinks('run-second', 'loading');
    expect(state.canAccess).toBe(false);
    expect(state.viewHref).toBeNull();

    // Second run's saved report confirmed
    state = computeReportLinks('run-second', 'saved');
    expect(state.canAccess).toBe(true);
    expect(state.viewHref).toBe('/api/runs/run-second/explanation-report');
  });

  it('generates accurate finding deep-link fragments only for positive integers and saved runs', () => {
    expect(computeFindingReportHref('run-123', 1, 'saved')).toBe(
      '/api/runs/run-123/explanation-report#finding-1',
    );
    expect(computeFindingReportHref('run-123', 3, 'saved')).toBe(
      '/api/runs/run-123/explanation-report#finding-3',
    );
    expect(computeFindingReportHref('run-123', 0, 'saved')).toBeNull();
    expect(computeFindingReportHref('run-123', -1, 'saved')).toBeNull();
    expect(computeFindingReportHref(null, 1, 'saved')).toBeNull();
    expect(computeFindingReportHref('run-123', 1, 'loading')).toBeNull();
  });
});
