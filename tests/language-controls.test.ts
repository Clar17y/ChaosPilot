import { describe, expect, it, vi } from 'vitest';
import { OutputLanguageControl } from '../src/web/language-controls.ts';
import { FindingExplanationSession, reportStateText } from '../src/web/finding-explanations.ts';
import { ENGLISH_REPORT_LABELS, getStaticReportLabels, validateCustomReportLabels } from '../src/output-language.ts';
import { buildExplanationPrompt, buildRunEvidence, generateReport } from '../src/explanations/index.ts';
import { buildInvestigationPrompt } from '../src/investigation/prompt.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { SEEDED_RECOVERY_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import * as recovery from '../src/recovery/index.ts';

function controls() {
  const select = { value: 'en', disabled: false };
  const custom = { value: '', disabled: false, validationMessage: '', setCustomValidity(message: string) { this.validationMessage = message; } };
  const wrap = { hidden: true, classList: { toggle(_name: string, hidden: boolean) { wrap.hidden = hidden; } } };
  const control = new OutputLanguageControl(select as HTMLSelectElement, custom as unknown as HTMLInputElement, wrap as unknown as HTMLElement);
  return { select, custom, wrap, control };
}

describe('production output language controls', () => {
  it('preserves a same-run choice across refreshes and defaults only on another run', () => {
    const { select, custom, control } = controls();
    control.syncToRun({ id: 'a', outputLanguage: 'en' });
    select.value = 'custom'; custom.value = 'es-mx';
    control.syncToRun({ id: 'a', outputLanguage: 'en' });
    expect(control.read()).toBe('es-MX');
    control.syncToRun({ id: 'b', outputLanguage: 'fr' });
    expect(select.value).toBe('custom'); expect(custom.value).toBe('fr');
    control.syncToRun(null);
    expect(control.read()).toBe('en');
  });

  it('exposes incomplete custom input as invalid without throwing while typing', () => {
    const { select, custom, control, wrap } = controls();
    select.value = 'custom';
    expect(() => control.update()).not.toThrow();
    expect(wrap.hidden).toBe(false);
    expect(custom.validationMessage).toContain('Enter a custom language');
    expect(() => control.read()).toThrow();
    custom.value = 'fr-'; control.update();
    expect(control.error).toMatch(/language tag/i);
    custom.value = 'pt-br'; control.update();
    expect(custom.validationMessage).toBe(''); expect(control.read()).toBe('pt-BR');
    select.value = 'en'; control.update();
    expect(wrap.hidden).toBe(true); expect(control.error).toBeNull();
  });

  it('captures the report choice, locks its controls and immediately labels the saved response', async () => {
    const { select, custom, control } = controls();
    const session = new FindingExplanationSession();
    select.value = 'custom'; custom.value = 'es-MX';
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response);
    const changed = () => control.setBusy(session.state.kind === 'generating');
    const pending = session.create({ id: 'a', status: 'completed', findings: [{}] }, 'meta', control.read(), changed, fetcher);
    expect(select.disabled).toBe(true); expect(custom.disabled).toBe(true);
    custom.value = 'ja'; // Even a programmatic change cannot alter the captured request.
    release(new Response(JSON.stringify({ language: 'es-MX', generatedAt: 'now', mode: 'meta', model: 'fake' })));
    expect(await pending).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ mode: 'meta', language: 'es-MX' });
    expect(reportStateText(session.state)).toContain('es-MX');
    expect(select.disabled).toBe(false); expect(custom.disabled).toBe(false);
  });

  it('ignores a report completing after another run was opened', async () => {
    const session = new FindingExplanationSession();
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const pending = session.create({ id: 'a', status: 'completed', findings: [{}] }, 'meta', 'es', () => {}, async () => response);
    session.resetForRun('b');
    release(new Response(JSON.stringify({ language: 'es', mode: 'meta' })));
    expect(await pending).toBe(false);
    expect(session.runId).toBe('b'); expect(session.state.kind).toBe('idle');
  });
});

describe('report label translation contract and regional output', () => {
  it('requires the original placeholder set for every translated label', () => {
    expect(validateCustomReportLabels({ ...ENGLISH_REPORT_LABELS })).toEqual(ENGLISH_REPORT_LABELS);
    for (const value of ['Modelo', 'Modelo {modelName}', 'Modelo {model} {count}', 'Modelo {model} {']) {
      expect(() => validateCustomReportLabels({ ...ENGLISH_REPORT_LABELS, metaSourceLabelTemplate: value })).toThrow(/placeholder/);
    }
    expect(() => validateCustomReportLabels({ ...ENGLISH_REPORT_LABELS, extra: 'unexpected' })).toThrow(/dictionary key/);
  });

  it('uses static Spanish labels for a regional tag while retaining the exact request language', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const record = await runInvestigation({ variant: 'recovery-candidate-a', systemBrief, provider: new MockProvider(), outputLanguage: 'es-MX' });
    expect(record.outputLanguage).toBe('es-MX');
    const evidence = buildRunEvidence(record);
    expect(buildExplanationPrompt(evidence, undefined, 'es-MX').systemMessage).toContain('(es-MX)');
    expect(buildExplanationPrompt(evidence, undefined, 'en-GB').systemMessage).toContain('(en-GB)');
    expect(getStaticReportLabels('es-MX')?.title).toBe('Resultados de la investigación');
    const report = await generateReport(record, { mode: 'offline' });
    expect(report.html).toContain('lang="es-MX"');
    expect(report.html).toContain('Resultados de la investigación');
    expect(record.findings[0]!.violation.invariant).toBe('recovery_deadline');

    const custom = buildExplanationPrompt(evidence, undefined, 'fr');
    expect(custom.systemMessage).toContain(JSON.stringify(ENGLISH_REPORT_LABELS));
    expect(custom.systemMessage).toContain('preserve every template placeholder');

    const first = record.experiments[0]!;
    const context = { contract: recovery.getContract(), source: recovery.getSourceBundle('recovery-candidate-a'),
      systemBrief, history: [{ experiment: first.experiment, result: first.result }], experimentNumber: 2,
      maxExperiments: 3, feedback: ['Return a shorter valid plan'], outputLanguage: 'es-MX' };
    for (const prompt of [buildInvestigationPrompt(context), buildInvestigationPrompt(context, { start: 0 })]) {
      expect(prompt.userMessage).toContain('(es-MX)');
      expect(prompt.userMessage).toContain('INVALID PROPOSAL FEEDBACK:');
      expect(prompt.userMessage).toContain('recovery_deadline');
      expect(prompt.userMessage).toContain('disconnect');
      expect(prompt.userMessage).toContain('MUST remain exact and untranslated');
    }
    expect(record.proposalAttempts?.every(attempt => attempt.requestSent === false)).toBe(true);
  });
});
