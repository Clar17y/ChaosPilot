import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { initFunctionalWorkspaceView, type FunctionalContext } from '../src/web/functional.ts';

// Minimal DOM surface used by this view, consistent with the repository's UI test pattern.
class Element {
  value = ''; textContent = ''; innerHTML = ''; disabled = false; title = ''; type = '';
  children: Element[] = [];
  classes = new Set<string>();
  classList = { toggle: (name: string, force: boolean) => { if (force) this.classes.add(name); else this.classes.delete(name); } };
  listeners = new Map<string, (() => void)[]>();
  replaceChildren(...children: Element[]) { this.children = children; this.textContent = ''; }
  append(child: Element) { this.children.push(child); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
  dispatch(name: string) { this.listeners.get(name)?.forEach(fn => fn()); }
}
afterEach(() => vi.unstubAllGlobals());

describe('functional production browser bindings', () => {
  it('renders actual controller eligibility and rechecks it on click; uses confirmed target choices', async () => {
    const elements = new Map<string, Element>();
    const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
    vi.stubGlobal('document', { getElementById: el, createElement: () => new Element() });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async function(this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(url); return { ok: true, status: 200, json: async () => [] };
    });
    const onTargetChange = vi.fn(); const controller = initFunctionalWorkspaceView(onTargetChange);
    const context: FunctionalContext = { systemId: 'trading-gateway', revision: 7, hasSelectedSystem: true,
      selectedAdapterId: 'synthetic-trading', isDraftMode: false, hasUnsavedSystemEdits: false, isSystemSavePending: false,
      targetState: 'ready', snapshotState: 'ready', allowedVariants: ['clean', 'candidate-c'], selectedVariant: 'clean' };
    controller.setContext(context);
    expect(el('btn-run-functional').disabled).toBe(false);
    expect(el('functional-system-display').value).toContain('revision 7');
    expect(el('functional-target-select').children.map(c => c.value)).toEqual(['clean', 'candidate-c']);
    el('functional-target-select').value = 'candidate-c'; el('functional-target-select').dispatch('change');
    expect(onTargetChange).toHaveBeenCalledWith('candidate-c');
    controller.setContext({ ...context, hasUnsavedSystemEdits: true });
    expect(el('btn-run-functional').disabled).toBe(true);
    expect(el('functional-target-select').disabled).toBe(true);
    el('btn-run-functional').dispatch('click'); await Promise.resolve();
    expect(calls).not.toContain('/api/functional/run');
    controller.setContext({ ...context, isDraftMode: true });
    expect(el('functional-system-display').value).toBe('New profile (draft)');
    controller.setContext({ ...context, isSystemSavePending: true });
    expect(el('btn-run-functional').disabled).toBe(true);
    controller.setContext(context); expect(el('btn-run-functional').disabled).toBe(false);
  });

  it('connects app-held saved/draft/edit/save/target state to the tested controller', async () => {
    const app = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
    const workspace = await readFile(new URL('../src/web/workspace.ts', import.meta.url), 'utf8');
    expect(app).toContain("import { initFunctionalWorkspaceView } from './functional.ts'");
    expect(app).toContain('functionalController.setContext({');
    for (const field of ['systemId: selectedSystem?.id', 'revision: selectedSystem?.revision', 'isDraftMode, hasUnsavedSystemEdits, isSystemSavePending',
      'targetState: effectiveTargetState()', 'snapshotState: effectiveSnapshotState()', 'allowedVariants: scopedVariants()', 'selectedVariant: targetSelection.selection']) expect(app).toContain(field);
    expect(workspace).not.toContain('document.');
    expect(workspace).not.toContain('fetch(');
  });
});
