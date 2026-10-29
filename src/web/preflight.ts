/** Request-size assessment for one saved launch selection. No prompts cross this boundary. */
export interface PreflightSelection {
  systemId: string;
  expectedRevision: number;
  adapterId: string;
  variant: string;
  provider: string;
  maxExperiments: number;
}
export interface RequestAssessment {
  mode: 'live';
  systemId: string;
  revision: number;
  adapterId: string;
  variant: string;
  requestBytes: number;
  limitBytes: number;
  maxOutputTokens: number;
}
const growthNote = 'Later experiments add context, so this check does not guarantee the whole run will fit.';
export function describeRequestAssessment(value: RequestAssessment): string {
  const headroom = value.limitBytes - value.requestBytes;
  const state = headroom < 0 ? 'Already exceeds the request limit'
    : headroom <= value.limitBytes * 0.2 ? 'Little request headroom' : 'Initial request fits';
  return `${state}: ${value.requestBytes.toLocaleString('en-US')} / ${value.limitBytes.toLocaleString('en-US')} bytes. Output limit: ${value.maxOutputTokens.toLocaleString('en-US')} tokens. ${growthNote}`;
}

export type PreflightFetcher = (selection: PreflightSelection) => Promise<unknown>;
export async function fetchRequestAssessment(selection: PreflightSelection): Promise<unknown> {
  const response = await fetch('/api/investigation/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selection), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Request preflight unavailable');
  return response.json();
}

/** Token and full identity protect against late responses, including A → B → A. */
export class RequestPreflight {
  private generation = 0;
  private key: string | undefined;
  public checking = false;
  public overLimit = false;
  public warning = false;
  constructor(private readonly notify: (text: string) => void, private readonly fetcher: PreflightFetcher = fetchRequestAssessment) {}

  async update(selection: PreflightSelection | null): Promise<void> {
    const key = JSON.stringify(selection);
    if (key === this.key) return;
    this.key = key;
    const generation = ++this.generation;
    this.checking = false;
    this.overLimit = false;
    this.warning = false;
    if (!selection) {
      this.notify('Request preflight unavailable until a saved system revision and supported target are selected.');
      return;
    }
    if (selection.provider === 'mock') {
      this.notify('Scripted mock mode: no live model request and no live request-size preflight.');
      return;
    }
    this.checking = true;
    this.notify('Checking initial serialized request size. Live request readiness is not yet assessed.');
    try {
      const result = await this.fetcher(selection) as Partial<RequestAssessment> | null;
      if (generation !== this.generation) return;
      if (!result || result.mode !== 'live' || result.systemId !== selection.systemId
        || result.revision !== selection.expectedRevision || result.adapterId !== selection.adapterId || result.variant !== selection.variant
        || !Number.isSafeInteger(result.requestBytes) || result.requestBytes! < 0
        || !Number.isSafeInteger(result.limitBytes) || result.limitBytes! <= 0
        || !Number.isSafeInteger(result.maxOutputTokens) || result.maxOutputTokens! <= 0) {
        throw new Error('Unconfirmed preflight identity or bounds');
      }
      this.checking = false;
      this.overLimit = result.requestBytes! > result.limitBytes!;
      this.warning = result.requestBytes! >= result.limitBytes! * 0.8;
      this.notify(describeRequestAssessment(result as RequestAssessment));
    } catch {
      if (generation === this.generation) {
        this.checking = false;
        this.warning = true;
        this.notify('Request preflight unavailable; initial request size and headroom are unknown. Check the server configuration or reload to retry. Launch remains available, subject to provider limits.');
      }
    }
  }
}
