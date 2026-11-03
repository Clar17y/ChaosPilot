import { normalizeOutputLanguage } from '../output-language.ts';

/** The same binding is used by investigation, report and challenge settings. */
export class OutputLanguageControl {
  private runId: string | null | undefined;
  constructor(
    private readonly select: HTMLSelectElement | null,
    private readonly custom: HTMLInputElement | null,
    private readonly wrap: HTMLElement | null,
  ) {}

  read(): string {
    if (this.select?.value === 'custom') {
      if (!this.custom?.value.trim()) throw new Error('Enter a custom language tag, such as fr or pt-BR.');
      return normalizeOutputLanguage(this.custom.value);
    }
    return normalizeOutputLanguage(this.select?.value);
  }

  get error(): string | null {
    try { this.read(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  update(): void {
    this.wrap?.classList.toggle('hidden', this.select?.value !== 'custom');
    this.custom?.setCustomValidity(this.error ?? '');
  }

  syncToRun(record: { id: string; outputLanguage?: string } | null): void {
    if (this.runId === (record?.id ?? null)) return;
    this.runId = record?.id ?? null;
    const language = normalizeOutputLanguage(record?.outputLanguage);
    if (this.select) this.select.value = ['en', 'es'].includes(language) ? language : 'custom';
    if (this.custom) this.custom.value = ['en', 'es'].includes(language) ? '' : language;
    this.update();
  }

  setBusy(busy: boolean): void {
    if (this.select) this.select.disabled = busy;
    if (this.custom) this.custom.disabled = busy;
  }
}
