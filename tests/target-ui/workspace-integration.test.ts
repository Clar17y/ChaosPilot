import { describe, it, expect } from 'vitest';
import { targetUiBlockedReason, type FunctionalContext } from '../../src/web/functional.ts';

describe('Target UI Workspace Integration and Guarding', () => {
  const readyContext: FunctionalContext = {
    systemId: 'trading-sys',
    revision: 1,
    isDraftMode: false,
    hasUnsavedSystemEdits: false,
    isSystemSavePending: false,
    hasSelectedSystem: true,
    selectedAdapterId: 'synthetic-trading',
    selectedVariant: 'clean',
    allowedVariants: ['clean', 'candidate-a'],
    targetState: 'ready',
    snapshotState: 'ready',
  };

  it('allows execution when valid synthetic-trading profile is saved and ready', () => {
    expect(targetUiBlockedReason(readyContext)).toBeNull();
  });

  it('blocks when no profile is selected', () => {
    const ctx: FunctionalContext = {
      ...readyContext,
      systemId: null,
      revision: null,
      hasSelectedSystem: false,
    };
    expect(targetUiBlockedReason(ctx)).toMatch(/Select a saved system profile/i);
    expect(targetUiBlockedReason(null)).toMatch(/Select a saved system profile/i);
  });

  it('blocks when in draft mode', () => {
    const ctx: FunctionalContext = {
      ...readyContext,
      isDraftMode: true,
    };
    expect(targetUiBlockedReason(ctx)).toMatch(/Save system profile before launching Target UI/i);
  });

  it('blocks when unsaved edits or save pending', () => {
    const unsavedCtx: FunctionalContext = {
      ...readyContext,
      hasUnsavedSystemEdits: true,
    };
    expect(targetUiBlockedReason(unsavedCtx)).toMatch(/Save pending profile edits/i);

    const pendingCtx: FunctionalContext = {
      ...readyContext,
      isSystemSavePending: true,
    };
    expect(targetUiBlockedReason(pendingCtx)).toMatch(/Save pending profile edits/i);
  });

  it('blocks when profile uses a non-synthetic-trading adapter', () => {
    const ctx: FunctionalContext = {
      ...readyContext,
      selectedAdapterId: 'order-book',
    };
    expect(targetUiBlockedReason(ctx)).toMatch(/Target UI journey only supports synthetic-trading/i);
  });

  it('blocks when target state is not ready or variant is missing', () => {
    const notReadyCtx: FunctionalContext = {
      ...readyContext,
      targetState: 'error',
    };
    expect(targetUiBlockedReason(notReadyCtx)).toMatch(/Select a valid target variant/i);

    const missingVariantCtx: FunctionalContext = {
      ...readyContext,
      selectedVariant: null,
    };
    expect(targetUiBlockedReason(missingVariantCtx)).toMatch(/Select a valid target variant/i);
  });
});
