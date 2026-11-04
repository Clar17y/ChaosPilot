import { describe, it, expect } from 'vitest';
import { FreshnessEngine } from '../../src/target-ui/freshness.ts';

describe('Target UI FreshnessEngine', () => {
  it('initializes in fresh state with zero age and sequence 0', () => {
    let now = 1000;
    const engine = new FreshnessEngine({ freshnessThresholdMs: 2000, clock: () => now });
    const f = engine.getFreshness();
    expect(f.status).toBe('fresh');
    expect(f.reason).toBe('none');
    expect(f.ageMs).toBe(0);
    expect(f.isHeld).toBe(false);
    expect(f.lastAppliedSequence).toBe(0);
  });

  it('rejects invalid freshness thresholds', () => {
    expect(() => new FreshnessEngine({ freshnessThresholdMs: 0 })).toThrow(/Invalid freshness threshold/);
    expect(() => new FreshnessEngine({ freshnessThresholdMs: -100 })).toThrow(/Invalid freshness threshold/);
    expect(() => new FreshnessEngine({ freshnessThresholdMs: 1.5 })).toThrow(/Invalid freshness threshold/);
  });

  it('transitions to stale when age crosses the exact threshold', () => {
    let now = 1000;
    const threshold = 1500;
    const engine = new FreshnessEngine({ freshnessThresholdMs: threshold, clock: () => now });

    // Boundary: exactly at threshold is still fresh
    now = 1000 + threshold;
    let f = engine.getFreshness();
    expect(f.status).toBe('fresh');
    expect(f.ageMs).toBe(threshold);

    // Boundary: 1ms past threshold becomes stale
    now = 1000 + threshold + 1;
    f = engine.getFreshness();
    expect(f.status).toBe('stale');
    expect(f.reason).toBe('age-exceeded');
    expect(f.ageMs).toBe(threshold + 1);

    // Resetting when an observation is applied restores freshness
    engine.recordApplied(1);
    f = engine.getFreshness();
    expect(f.status).toBe('fresh');
    expect(f.reason).toBe('none');
    expect(f.ageMs).toBe(0);
    expect(f.lastAppliedSequence).toBe(1);
  });

  it('labels held updates stale immediately and keeps underlying sequence unchanged', () => {
    let now = 2000;
    const engine = new FreshnessEngine({ freshnessThresholdMs: 5000, clock: () => now });
    engine.recordApplied(2);

    engine.hold();
    expect(engine.getHeld()).toBe(true);

    const f = engine.getFreshness();
    expect(f.status).toBe('stale');
    expect(f.reason).toBe('held');
    expect(f.isHeld).toBe(true);
    expect(f.lastAppliedSequence).toBe(2);

    // When held, checkIncoming reports held and rejects application
    const check = engine.checkIncoming({ instanceId: 'inst-1', processed: 3 });
    expect(check.canApply).toBe(false);
    expect(check.rejectReason).toBe('held');

    // Display retains sequence 2 even if time passes
    now = 3500;
    const f2 = engine.getFreshness();
    expect(f2.status).toBe('stale');
    expect(f2.reason).toBe('held');
    expect(f2.lastAppliedSequence).toBe(2);

    // Resume restores eligibility and applies latest update
    engine.resume();
    expect(engine.getHeld()).toBe(false);

    const checkResume = engine.checkIncoming({ instanceId: 'inst-1', processed: 3 });
    expect(checkResume.canApply).toBe(true);
    expect(checkResume.rejectReason).toBeNull();

    engine.recordApplied(3);
    const f3 = engine.getFreshness();
    expect(f3.status).toBe('fresh');
    expect(f3.reason).toBe('none');
    expect(f3.lastAppliedSequence).toBe(3);
    expect(f3.ageMs).toBe(0);
  });

  it('rejects foreign instance observations without altering state', () => {
    let now = 1000;
    const engine = new FreshnessEngine({ clock: () => now });
    engine.setInstanceId('expected-inst-1');

    const checkForeign = engine.checkIncoming({ instanceId: 'foreign-inst-2', processed: 1 });
    expect(checkForeign.canApply).toBe(false);
    expect(checkForeign.rejectReason).toBe('foreign-instance');

    // Freshness remains intact
    const f = engine.getFreshness();
    expect(f.lastAppliedSequence).toBe(0);
  });

  it('rejects out-of-order sequence observations without regressing sequence', () => {
    let now = 1000;
    const engine = new FreshnessEngine({ clock: () => now });
    engine.recordApplied(5);

    // Out of order: sequence 4 arrives after 5
    const checkOld = engine.checkIncoming({ instanceId: 'any', processed: 4 });
    expect(checkOld.canApply).toBe(false);
    expect(checkOld.rejectReason).toBe('out-of-order');

    // Sequence 5 is equal (acceptable as idempotent / same checkpoint)
    const checkSame = engine.checkIncoming({ instanceId: 'any', processed: 5 });
    expect(checkSame.canApply).toBe(true);

    // Sequence 6 is newer
    const checkNew = engine.checkIncoming({ instanceId: 'any', processed: 6 });
    expect(checkNew.canApply).toBe(true);
  });
});
