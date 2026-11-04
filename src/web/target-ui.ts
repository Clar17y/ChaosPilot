import { FreshnessEngine } from '../target-ui/freshness.ts';
import { validObservation, validReceipt } from '../target-ui/validation.ts';
import type {
  TargetUiObservationRecord,
  TargetUiOrderDisplay,
  TargetUiProvenance,
  TargetUiWireExchange,
} from '../target-ui/types.ts';
import type { BusinessEvent, Observation } from '../target-api/types.ts';

const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const FETCH_TIMEOUT_MS = 1500;
const MAX_EXCHANGES = 240;

const isQty = (v: number) => Number.isSafeInteger(v) && v > 0 && v <= 1000;
let requestCounter = 0;
const nextRequestId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;

export class TargetUiController {
  private freshness: FreshnessEngine;
  private endpoint = '';
  private instanceId: string | null = null;
  private variant = 'clean';
  private provenance: TargetUiProvenance | undefined;
  private convergenceDeadlineMs = 5000;
  private trackedOrderId = 'order-1';
  private trackedRequestId = '';
  private trackedReceiptId: string | null = null;
  private activeOrder: TargetUiOrderDisplay | null = null;
  private exchanges: TargetUiWireExchange[] = [];
  private events: BusinessEvent[] = [];
  private observations: TargetUiObservationRecord[] = [];
  private lastSeenProcessed = 0;
  private lastSeenQueued = 0;
  private resumeAtMs: number | undefined;
  private readonly startedAt = new Date().toISOString();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight = false;
  private readonly busy = new Set<string>();
  private readonly abort = new AbortController();
  private destroyed = false;
  private autoPoll = true;

  constructor(options: { freshnessThresholdMs?: number; endpoint?: string } = {}) {
    this.freshness = new FreshnessEngine({ freshnessThresholdMs: options.freshnessThresholdMs ?? 2000 });
    this.endpoint = options.endpoint || (typeof window !== 'undefined' ? window.location.origin : '');
  }

  init(): void {
    if (typeof window === 'undefined') return;
    this.bindDom();
    this.updateDom();
    void this.loadContext().then(() => this.poll());
    this.tickTimer = setInterval(() => this.tick(), 100);
    this.pollTimer = setInterval(() => {
      if (this.autoPoll && !this.freshness.getHeld()) void this.poll();
    }, 250);
  }

  destroy(): void {
    this.destroyed = true;
    this.abort.abort(new Error('Target UI controller destroyed'));
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  getState() {
    return {
      endpoint: this.endpoint,
      instanceId: this.instanceId,
      trackedOrderId: this.trackedOrderId,
      trackedRequestId: this.trackedRequestId,
      trackedReceiptId: this.trackedReceiptId,
      activeOrder: this.activeOrder ? structuredClone(this.activeOrder) : null,
      freshness: this.freshness.getFreshness(),
      exchangesCount: this.exchanges.length,
      eventsCount: this.events.length,
      observationsCount: this.observations.length,
      isHeld: this.freshness.getHeld(),
    };
  }

  getEvidence() {
    return {
      id: `ui-manual-${Date.now().toString(36)}`,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      variant: this.variant,
      instanceId: this.instanceId ?? '',
      endpoint: this.endpoint,
      orderId: this.trackedOrderId,
      requestId: this.trackedRequestId,
      receiptId: this.trackedReceiptId,
      systemBriefId: this.provenance?.systemSnapshot.brief.id,
      systemBriefRevision: this.provenance?.systemSnapshot.brief.revision,
      sourceHash: this.provenance?.sourceHash,
      provenance: this.provenance ? structuredClone(this.provenance) : undefined,
      resumeAtMs: this.resumeAtMs,
      thresholds: { freshnessThresholdMs: this.freshness.getThresholdMs(), convergenceDeadlineMs: this.convergenceDeadlineMs },
      exchanges: structuredClone(this.exchanges),
      events: structuredClone(this.events),
      uiObservations: structuredClone(this.observations),
      freshnessState: this.freshness.getFreshness(),
      status: 'inconclusive' as const,
      classification: 'inconclusive-wire' as const,
      reasons: ['Manual interactive capture; not independently verified'],
    };
  }

  private el<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Element #${id} not found`);
    return element as T;
  }

  private safeEl<T extends HTMLElement>(id: string): T | null {
    return typeof document === 'undefined' ? null : (document.getElementById(id) as T | null);
  }

  private setFeedback(id: string, text: string): void {
    const element = this.safeEl(id);
    if (element) element.textContent = text;
  }

  private bindDom(): void {
    this.el<HTMLButtonElement>('btn-submit-setup').addEventListener('click', () => {
      void this.submitSetup(Number(this.el<HTMLInputElement>('input-setup-limit').value));
    });
    this.el<HTMLButtonElement>('btn-submit-order').addEventListener('click', () => {
      void this.submitOrder(this.el<HTMLInputElement>('input-order-id').value.trim(), Number(this.el<HTMLInputElement>('input-order-qty').value));
    });
    this.el<HTMLButtonElement>('btn-submit-exec').addEventListener('click', () => {
      void this.submitExecution(
        this.el<HTMLInputElement>('input-exec-order-id').value.trim(),
        this.el<HTMLInputElement>('input-exec-id').value.trim(),
        Number(this.el<HTMLInputElement>('input-exec-qty').value),
      );
    });
    this.el<HTMLButtonElement>('btn-toggle-hold').addEventListener('click', () => this.toggleHold());
    this.el<HTMLButtonElement>('btn-poll-now').addEventListener('click', () => { void this.poll(); });
    this.el<HTMLButtonElement>('btn-export-evidence').addEventListener('click', () => this.exportEvidence());
  }

  /** Bounded fetch on the controller lifetime; every outcome is recorded as an exchange. */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const startMs = performance.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`Target request timed out after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
    const onAbort = () => timeout.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
      });
      let data: unknown;
      try { data = await res.json(); } catch { data = undefined; }
      this.pushExchange({
        method, path, requestBody: body, responseStatus: res.status, responseBody: data,
        timestampMs: performance.now(), elapsedMs: performance.now() - startMs, source: 'browser',
      });
      return { status: res.status, data };
    } catch (err) {
      this.pushExchange({
        method, path, requestBody: body, responseStatus: 0, responseBody: undefined,
        timestampMs: performance.now(), elapsedMs: performance.now() - startMs, source: 'browser',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  private pushExchange(exchange: TargetUiWireExchange): void {
    this.exchanges.push(exchange);
    while (this.exchanges.length > MAX_EXCHANGES) {
      const dropAt = this.exchanges.findIndex(e => e.method === 'GET');
      if (dropAt < 0) break;
      this.exchanges.splice(dropAt, 1);
    }
  }

  private async loadContext(): Promise<void> {
    try {
      const { status, data } = await this.request('GET', '/ui-context');
      if (status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) return;
      const ctx = data as Record<string, any>;
      if (typeof ctx.instanceId === 'string' && ctx.instanceId) {
        this.instanceId = ctx.instanceId;
        this.freshness.setInstanceId(ctx.instanceId);
      }
      if (typeof ctx.variant === 'string' && ctx.variant) this.variant = ctx.variant;
      if (ctx.provenance && typeof ctx.provenance === 'object') this.provenance = ctx.provenance as TargetUiProvenance;
      const threshold = ctx.thresholds?.freshnessThresholdMs;
      if (Number.isSafeInteger(threshold) && threshold > 0 && threshold !== this.freshness.getThresholdMs()) {
        const held = this.freshness.getHeld();
        this.freshness = new FreshnessEngine({ freshnessThresholdMs: threshold });
        if (this.instanceId) this.freshness.setInstanceId(this.instanceId);
        if (held) this.freshness.hold();
        const label = this.safeEl('val-freshness-threshold');
        if (label) label.textContent = `${threshold}ms`;
      }
      const deadline = ctx.thresholds?.convergenceDeadlineMs;
      if (Number.isSafeInteger(deadline) && deadline > 0) this.convergenceDeadlineMs = deadline;
      this.updateDom();
    } catch { /* context is optional; polling still discovers the instance */ }
  }

  private async guard(key: string, buttonId: string, work: () => Promise<void>): Promise<void> {
    if (this.busy.has(key) || this.destroyed) return;
    this.busy.add(key);
    const btn = this.safeEl<HTMLButtonElement>(buttonId);
    if (btn) btn.disabled = true;
    try { await work(); } finally {
      this.busy.delete(key);
      if (btn) btn.disabled = false;
    }
  }

  async submitSetup(limit: number): Promise<void> {
    return this.guard('setup', 'btn-submit-setup', async () => {
      if (!isQty(limit)) { this.setFeedback('feedback-setup', 'Setup error: limit must be an integer 1-1000'); return; }
      this.setFeedback('feedback-setup', 'Submitting setup…');
      const requestId = nextRequestId('setup');
      try {
        const { status, data } = await this.request('POST', '/setup', { requestId, kind: 'setup', limit });
        if (status === 202 && validReceipt(data, this.instanceId, requestId)) {
          this.instanceId = data.instanceId;
          this.freshness.setInstanceId(data.instanceId);
          this.setFeedback('feedback-setup', `Setup queued (receipt ${data.receiptId.slice(0, 8)}…)`);
          this.updateDom();
          this.captureObservation('after-setup');
          await this.poll();
        } else {
          this.setFeedback('feedback-setup', `Setup failed: ${status === 202 ? 'invalid or foreign receipt' : ((data as any)?.error ?? `HTTP ${status}`)}`);
        }
      } catch (err) { this.setFeedback('feedback-setup', `Setup error: ${String(err)}`); }
    });
  }

  async submitOrder(orderId: string, quantity: number): Promise<void> {
    return this.guard('order', 'btn-submit-order', async () => {
      if (!ID_PATTERN.test(orderId)) { this.setFeedback('feedback-order', 'Order error: order ID must be a lowercase id'); return; }
      if (!isQty(quantity)) { this.setFeedback('feedback-order', 'Order error: quantity must be an integer 1-1000'); return; }
      this.setFeedback('feedback-order', 'Submitting order…');
      const requestId = nextRequestId('ord-req');
      try {
        const { status, data } = await this.request('POST', '/orders', { requestId, kind: 'order', orderId, quantity });
        if (status === 202 && validReceipt(data, this.instanceId, requestId)) {
          this.trackedOrderId = orderId;
          this.trackedRequestId = requestId;
          this.trackedReceiptId = data.receiptId;
          if (!this.instanceId) { this.instanceId = data.instanceId; this.freshness.setInstanceId(data.instanceId); }
          // Transport acknowledgement only: business status stays IDLE until an applied event.
          this.activeOrder = {
            orderId, transportStatus: 'queued', transportReceiptId: data.receiptId, transportSequence: data.sequence,
            businessStatus: 'IDLE', quantity, filledQuantity: 0, remainingQuantity: quantity,
          };
          this.setFeedback('feedback-order', `Order queued (202 Accepted, seq #${data.sequence})`);
          this.updateDom();
          this.captureObservation('after-order-transport');
          await this.poll();
        } else {
          this.setFeedback('feedback-order', `Order rejected: ${status === 202 ? 'invalid or foreign receipt' : ((data as any)?.error ?? `HTTP ${status}`)}`);
        }
      } catch (err) { this.setFeedback('feedback-order', `Order error: ${String(err)}`); }
    });
  }

  async submitExecution(orderId: string, executionId: string, quantity: number): Promise<void> {
    return this.guard('exec', 'btn-submit-exec', async () => {
      if (!ID_PATTERN.test(orderId) || !ID_PATTERN.test(executionId)) { this.setFeedback('feedback-exec', 'Execution error: ids must be lowercase ids'); return; }
      if (!isQty(quantity)) { this.setFeedback('feedback-exec', 'Execution error: quantity must be an integer 1-1000'); return; }
      this.setFeedback('feedback-exec', 'Submitting execution fill…');
      const requestId = nextRequestId('exec-req');
      try {
        const { status, data } = await this.request('POST', '/executions', { requestId, kind: 'execution', orderId, executionId, quantity });
        if (status === 202 && validReceipt(data, this.instanceId, requestId)) {
          this.setFeedback('feedback-exec', `Fill queued (202 Accepted, seq #${data.sequence})`);
          this.updateDom();
          this.captureObservation('after-execution-transport');
          await this.poll();
        } else {
          this.setFeedback('feedback-exec', `Fill rejected: ${status === 202 ? 'invalid or foreign receipt' : ((data as any)?.error ?? `HTTP ${status}`)}`);
        }
      } catch (err) { this.setFeedback('feedback-exec', `Execution error: ${String(err)}`); }
    });
  }

  toggleHold(): void {
    const btn = this.safeEl<HTMLButtonElement>('btn-toggle-hold');
    const holdStatus = this.safeEl('label-hold-status');
    if (this.freshness.getHeld()) {
      this.resumeAtMs = performance.now();
      this.freshness.resume();
      if (btn) {
        btn.textContent = 'Hold Updates (Simulate Stale)';
        btn.setAttribute('aria-pressed', 'false');
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-warning');
      }
      if (holdStatus) holdStatus.textContent = 'Updates: Active';
      void this.poll().then(() => this.captureObservation('after-resume'));
    } else {
      this.freshness.hold();
      if (btn) {
        btn.textContent = 'Resume Updates';
        btn.setAttribute('aria-pressed', 'true');
        btn.classList.remove('btn-warning');
        btn.classList.add('btn-secondary');
      }
      if (holdStatus) holdStatus.textContent = 'Updates: HELD (Intentional Stale)';
      this.updateDom();
      this.captureObservation('while-held');
    }
  }

  async poll(): Promise<void> {
    if (this.pollInFlight || this.destroyed) return;
    this.pollInFlight = true;
    try {
      const { status, data } = await this.request('GET', '/events');
      if (status !== 200) return;
      // Validate shape, instance, sequence monotonicity and accounting before any mutation.
      if (!validObservation(data, this.instanceId, this.freshness.getLastAppliedSequence())) return;
      const obs = data as Observation;
      if (!this.instanceId) { this.instanceId = obs.instanceId; this.freshness.setInstanceId(obs.instanceId); }
      this.lastSeenProcessed = obs.processed;
      this.lastSeenQueued = obs.queued;

      const check = this.freshness.checkIncoming({ instanceId: obs.instanceId, processed: obs.processed });
      if (!check.canApply) {
        // Held/rejected: retained display and event log stay untouched; only age/labels move.
        this.tick();
        return;
      }
      this.events = structuredClone(obs.events);
      this.applyOrderObservation(obs);
      this.freshness.recordApplied(obs.processed);
      this.updateDom(obs, true);
    } catch {
      // Network failure keeps the previous display intact; age tick will label it stale.
    } finally {
      this.pollInFlight = false;
    }
  }

  /** A settled receipt, not an order ID alone, owns the displayed business state. */
  private applyOrderObservation(obs: Observation): void {
    const event = obs.events.findLast(event => {
      const command = event.command;
      if (command.kind !== 'order' || command.orderId !== this.trackedOrderId) return false;
      if (!this.trackedRequestId) return event.status === 'accepted';
      return event.requestId === this.trackedRequestId
        && event.receiptId === this.trackedReceiptId
        && event.sequence === this.activeOrder?.transportSequence
        && command.quantity === this.activeOrder?.quantity;
    });
    if (!event) return;

    const order = event.status === 'accepted' ? obs.orders[this.trackedOrderId] : undefined;
    if (event.status === 'accepted' && !order) return;
    const quantity = order?.initialQuantity ?? this.activeOrder?.quantity;
    if (quantity === undefined) return;

    this.trackedRequestId = event.requestId;
    this.trackedReceiptId = event.receiptId;
    this.activeOrder = {
      orderId: this.trackedOrderId,
      transportStatus: 'acknowledged',
      transportReceiptId: event.receiptId,
      transportSequence: event.sequence,
      businessStatus: order?.businessStatus ?? (event.status === 'rejected' ? 'REJECTED' : 'ERROR'),
      quantity,
      filledQuantity: order?.filledQuantity ?? 0,
      remainingQuantity: order?.remainingQuantity ?? quantity,
    };
    if (event.status !== 'accepted') {
      this.setFeedback('feedback-order', `Order ${event.status}: ${event.reason ?? event.status}`);
    }
  }

  private tick(): void {
    const f = this.freshness.getFreshness();
    const ageEl = this.safeEl('display-age');
    if (ageEl) ageEl.textContent = `${f.ageMs}ms`;
    const badgeEl = this.safeEl('badge-freshness');
    const orderFreshnessEl = this.safeEl('badge-order-freshness');
    const alertEl = this.safeEl('terminal-alert');
    const alertTextEl = this.safeEl('terminal-alert-text');
    if (f.status === 'stale') {
      const label = f.reason === 'held' ? 'STALE (HELD)' : 'STALE (AGE EXCEEDED)';
      if (badgeEl) { badgeEl.textContent = label; badgeEl.className = 'badge badge-stale'; }
      if (orderFreshnessEl) { orderFreshnessEl.textContent = label; orderFreshnessEl.className = 'freshness-subbadge badge-stale'; }
      if (alertEl && alertTextEl) {
        alertEl.classList.remove('hidden');
        alertTextEl.textContent = f.reason === 'held'
          ? 'Updates are intentionally HELD. Displayed order data is retained older state while underlying target continues running.'
          : `Updates exceeded freshness threshold (${f.ageMs}ms > ${f.freshnessThresholdMs}ms). Displayed data is STALE.`;
      }
    } else {
      if (badgeEl) { badgeEl.textContent = 'FRESH'; badgeEl.className = 'badge badge-fresh'; }
      if (orderFreshnessEl) { orderFreshnessEl.textContent = 'FRESH'; orderFreshnessEl.className = 'freshness-subbadge'; }
      if (alertEl) alertEl.classList.add('hidden');
    }
  }

  /** Reads the actually rendered order fields back from the DOM. */
  private readDomOrder(): TargetUiOrderDisplay | null {
    if (typeof document === 'undefined') return this.activeOrder ? structuredClone(this.activeOrder) : null;
    const text = (id: string) => this.safeEl(id)?.textContent?.trim() ?? '';
    const orderId = text('disp-order-id');
    const businessStatus = text('disp-business-status-text');
    const transport = text('disp-transport-status').toLowerCase();
    const qty = Number(text('disp-requested-qty')), filled = Number(text('disp-filled-qty')), remaining = Number(text('disp-remaining-qty'));
    const seqRaw = text('disp-receipt-seq').replace(/^#/, '');
    const sequence = seqRaw === '-' || seqRaw === '' ? null : Number(seqRaw);
    const receipt = text('disp-receipt-id');
    if (!orderId || orderId === 'No Order Submitted' || !['IDLE', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'ERROR'].includes(businessStatus)
      || !['none', 'queued', 'acknowledged', 'failed'].includes(transport)
      || ![qty, filled, remaining].every(v => Number.isSafeInteger(v) && v >= 0)
      || (sequence !== null && !Number.isSafeInteger(sequence))) return null;
    return {
      orderId,
      transportStatus: transport as TargetUiOrderDisplay['transportStatus'],
      transportReceiptId: receipt === '-' || receipt === '' ? null : receipt,
      transportSequence: sequence,
      businessStatus: businessStatus as TargetUiOrderDisplay['businessStatus'],
      quantity: qty, filledQuantity: filled, remainingQuantity: remaining,
    };
  }

  captureObservation(phase: string): TargetUiObservationRecord {
    this.tick(); // ensure badge/age text matches the capture instant
    const f = this.freshness.getFreshness();
    const badgeText = this.safeEl('badge-freshness')?.textContent?.trim();
    const obs: TargetUiObservationRecord = {
      phase,
      timestampMs: performance.now(),
      domOrder: this.readDomOrder(),
      domFreshness: {
        status: f.status,
        reason: f.reason,
        label: badgeText || (f.status === 'stale' ? (f.reason === 'held' ? 'STALE (HELD)' : 'STALE') : 'FRESH'),
        ageMs: f.ageMs,
      },
      upstreamProcessed: this.lastSeenProcessed,
      upstreamQueued: this.lastSeenQueued,
      instanceId: this.instanceId ?? '',
      requestId: this.trackedRequestId,
      appliedSequence: f.lastAppliedSequence,
      freshnessThresholdMs: f.freshnessThresholdMs,
    };
    this.observations.push(obs);
    return obs;
  }

  private updateDom(obs?: Observation, applied = true): void {
    const el = (id: string) => this.safeEl(id);
    const endpointEl = el('display-endpoint');
    if (endpointEl) endpointEl.textContent = this.endpoint;
    const instanceEl = el('display-instance-id');
    if (instanceEl) instanceEl.textContent = this.instanceId ? this.instanceId.slice(0, 13) + '…' : '-';

    if (obs) {
      const upstreamEl = el('display-upstream');
      if (upstreamEl) upstreamEl.textContent = `P: ${obs.processed} / Q: ${obs.queued}`;
      if (applied && obs.state) {
        const limitEl = el('disp-credit-limit');
        if (limitEl) limitEl.textContent = String(obs.state.credit?.limit ?? '-');
        const reservedEl = el('disp-credit-reserved');
        if (reservedEl) reservedEl.textContent = String(obs.state.reservedCredit ?? '-');
        const usedEl = el('disp-credit-used');
        if (usedEl) usedEl.textContent = String(obs.state.usedCredit ?? '-');
      }
    }

    const order = this.activeOrder;
    if (order) {
      const set = (id: string, value: string) => { const n = el(id); if (n) n.textContent = value; };
      set('disp-order-id', order.orderId);
      const badgeStatus = el('badge-business-status');
      if (badgeStatus) {
        badgeStatus.textContent = order.businessStatus;
        badgeStatus.className = `status-badge badge-${order.businessStatus.toLowerCase().replace('_', '-')}`;
      }
      set('disp-transport-status', order.transportStatus.toUpperCase());
      set('disp-receipt-id', order.transportReceiptId ?? '-');
      set('disp-receipt-seq', order.transportSequence !== null ? `#${order.transportSequence}` : '-');
      set('disp-business-status-text', order.businessStatus);
      set('disp-requested-qty', String(order.quantity));
      set('disp-filled-qty', String(order.filledQuantity));
      set('disp-remaining-qty', String(order.remainingQuantity));
    }
    this.renderEventsTable();
  }

  private renderEventsTable(): void {
    const tbody = this.safeEl('tbody-events');
    if (!tbody) return;
    tbody.replaceChildren();
    const cell = (value: string, className?: string) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (className) td.className = className;
      return td;
    };
    const badgeCell = (value: string, className: string) => {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      td.append(span);
      return td;
    };
    if (this.events.length === 0 && this.exchanges.length === 0) {
      const tr = document.createElement('tr');
      const td = cell('No exchanges or events observed yet.', 'table-empty');
      td.colSpan = 7;
      tr.append(td);
      tbody.append(tr);
      return;
    }
    let idx = 1;
    for (const e of this.exchanges) {
      if (e.path === '/events' || e.path === '/state' || e.path === '/ui-context') continue;
      const req = (e.requestBody as any) ?? {};
      const res = (e.responseBody as any) ?? {};
      const tr = document.createElement('tr');
      const type = cell(`${e.method} ${e.path}`);
      tr.append(
        cell(String(idx++)), type,
        cell(typeof req.requestId === 'string' ? req.requestId : '-', 'mono small'),
        cell(typeof res.receiptId === 'string' ? res.receiptId.slice(0, 8) + '…' : '-', 'mono small'),
        badgeCell(String(e.responseStatus), `badge ${e.responseStatus === 202 ? 'badge-open' : 'badge-rejected'}`),
        cell('-'),
        cell(e.error ?? (e.responseStatus === 202 ? 'Queued' : (typeof res.error === 'string' ? res.error : '-')), 'small'),
      );
      tbody.append(tr);
    }
    for (const ev of this.events) {
      const tr = document.createElement('tr');
      tr.append(
        cell(String(idx++)),
        cell(`EVENT #${ev.sequence}`),
        cell(ev.requestId ?? '-', 'mono small'),
        cell(ev.receiptId ? ev.receiptId.slice(0, 8) + '…' : '-', 'mono small'),
        cell('-'),
        badgeCell(ev.status.toUpperCase(), `badge ${ev.status === 'accepted' ? 'badge-filled' : 'badge-rejected'}`),
        cell(ev.reason ?? (ev.command?.kind ? `${ev.command.kind} settled` : '-'), 'small'),
      );
      tbody.append(tr);
    }
  }

  exportEvidence(): void {
    const evidence = this.getEvidence();
    const json = JSON.stringify(evidence, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `target-ui-evidence-${this.instanceId ?? 'local'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const controller = new TargetUiController();
    controller.init();
    (window as any).__TARGET_UI__ = controller;
  });
}
