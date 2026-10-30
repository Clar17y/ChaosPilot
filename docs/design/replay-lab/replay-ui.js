(function () {
  const root = document.getElementById('chaospilot-replay-lab');
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const els = { select: $('#cprl-case'), caption: $('#cprl-caption'), packet: $('#cprl-packet'),
    flowState: $('#cprl-flow-state'), eventBox: $('#cprl-event'), changeBox: $('#cprl-change'),
    lens: $('#cprl-lens'), banner: $('#cprl-banner'), range: $('#cprl-range'), counter: $('#cprl-counter'),
    play: $('#cprl-play'), prev: $('#cprl-prev'), next: $('#cprl-next'), jump: $('#cprl-jump'),
    raw: $('#cprl-raw'), provenance: $('#cprl-provenance'), system: $('#cprl-system'),
    summary: $('#cprl-summary'), marker: $('#cprl-marker') };
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function readSaved(state) {
    try {
      const ws = state || (window.openai && window.openai.widgetState) || {};
      const mc = (ws && ws.modelContent) || {}, pc = (ws && ws.privateContent) || {};
      return { caseIndex: typeof mc.caseIndex === 'number' ? mc.caseIndex : (typeof pc.caseIndex === 'number' ? pc.caseIndex : 4),
        frameIndex: typeof pc.frameIndex === 'number' ? pc.frameIndex : (typeof mc.frameIndex === 'number' ? mc.frameIndex : undefined) };
    } catch (e) { return { caseIndex: 4, frameIndex: undefined }; }
  }
  let saved = readSaved();
  let caseIndex = clampIndex(saved.caseIndex, CASES.length);
  let frameIndex = 0;
  let current = null;
  let rafId = null;

  // One owned clock: the core controller, driven by requestAnimationFrame.
  // The same scheduler slot animates the packet between the labelled nodes;
  // cancelling the controller cancels the in-flight frame callback too.
  const controller = createPlaybackController({
    stepDuration: 950,
    onIndex: (i) => { frameIndex = i; render(); },
    onPlaying: (p) => { els.play.textContent = p ? 'Pause' : 'Play'; els.play.setAttribute('aria-pressed', String(p)); if (!p && els.packet) els.packet.style.opacity = '0'; },
    schedule: (cb) => {
      const start = performance.now(); const dur = 950;
      const loop = (now) => {
        if (!controller.playing) return;
        const p = Math.min((now - start) / dur, 1);
        if (els.packet) { els.packet.style.opacity = '1'; els.packet.setAttribute('cx', String(167 + p * 666)); }
        if (p >= 1) { cb(1); return; }
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
      return rafId;
    },
    cancel: () => { if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; } if (els.packet) els.packet.style.opacity = '0'; },
  });

  function persist() { // user interactions only — never load/render/restore
    try { if (window.openai && window.openai.setWidgetState) window.openai.setWidgetState({ modelContent: { caseIndex }, privateContent: { caseIndex, frameIndex } }).catch(() => {}); } catch (e) {}
  }
  function resetStage() {
    const c = clearedVisualState();
    els.caption.textContent = c.caption; els.eventBox.textContent = c.event; els.changeBox.textContent = c.change;
    els.flowState.textContent = c.flowState; els.banner.textContent = c.banner; els.banner.className = 'cprl-banner';
    els.marker.textContent = ''; els.marker.className = 'cprl-marker';
    els.lens.innerHTML = ''; if (els.packet) els.packet.style.opacity = '0';
  }
  function loadCase(i, startFrame) {
    controller.stop();
    caseIndex = clampIndex(i, CASES.length);
    const data = CASES[caseIndex];
    const built = buildFrames(data);
    current = { data, ...built };
    controller.switchTo(built.frames.length, clampIndex(startFrame ?? built.findingFrames[0] ?? built.actionFindingFrame ?? 0, built.frames.length));
    frameIndex = controller.index;
    els.select.value = String(caseIndex);
    els.system.textContent = data.systemLabel || 'Recorded system';
    els.provenance.textContent = data.demoNote || 'Recorded playback';
    els.summary.textContent = built.summary.violationsRecorded
      ? `${built.summary.uniqueMessages} finding${built.summary.uniqueMessages === 1 ? '' : 's'} recorded`
      : 'No violation recorded';
    render();
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function humanOutcome(o) {
    if (!o) return 'recorded';
    if (o === 'delivered:processed') return 'Processed';
    if (o === 'delivered:duplicate') return 'Duplicate';
    const w = String(o).replace(/[:_]+/g, ' ').trim();
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : 'recorded';
  }
  function fieldLabel(path) {
    return String(path).replace(/^target\./, '').split('.').map(part => part.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')).join(' · ');
  }
  function comparisons(rows, beforeLabel = 'Before', afterLabel = 'After') {
    return rows.map(d => `<div class="cprl-comparison"><div class="cprl-field">${esc(fieldLabel(d.path))}</div><div><small>${esc(beforeLabel)}</small><strong>${esc(formatValue(d.before))}</strong></div><span class="cprl-arrow" aria-hidden="true">→</span><div><small>${esc(afterLabel)}</small><strong>${esc(formatValue(d.after))}</strong></div></div>`).join('');
  }
  function bigArrow(before, after) {
    return `<div class="cprl-big"><span>${esc(formatValue(before))}</span><span class="cprl-arrow">→</span><span>${esc(formatValue(after))}</span></div>`;
  }
  function lensHtml(f) {
    if (!f) return '<p class="cprl-muted">No recorded entries in this case.</p>';
    if (!f.stateKnown) return '<h3>Observed state</h3><p class="cprl-big">State not recorded</p><p class="cprl-muted">No state was recorded for this entry; nothing is inferred from neighbouring entries.</p>';
    const v = f.visual;
    if (v.kind === 'capacity') {
      const scale = v.scaleMax || 1;
      let h = `<h3>Credit exposure</h3>${comparisons(v.comparison, 'Expected in recorded check', 'Observed')}<div class="cprl-big" style="margin-top:16px">${esc(formatValue(v.total))} <span class="cprl-muted" style="font-size:16px">total${v.limit !== null ? ` of ${esc(formatValue(v.limit))} limit` : ''}</span></div>`;
      if (v.used !== null && v.reserved !== null && v.used >= 0 && v.reserved >= 0) {
        const uw = Math.max(0, Math.min(100, v.usedPct || 0)), rw = Math.max(0, Math.min(100 - uw, v.reservedPct || 0));
        h += `<div class="cprl-stack" role="img" aria-label="Used ${esc(formatValue(v.used))} plus reserved ${esc(formatValue(v.reserved))} equals ${esc(formatValue(v.total))}${v.limit !== null ? ` against limit ${esc(formatValue(v.limit))}` : ''}"><div class="cprl-seg cprl-seg-used" style="left:0;width:${uw}%"></div><div class="cprl-seg cprl-seg-reserved" style="left:${uw}%;width:${rw}%"></div>${v.limitPct !== null ? `<div class="cprl-limit" style="left:${Math.min(100, v.limitPct)}%"><span>limit ${esc(formatValue(v.limit))}</span></div>` : ''}</div>`;
      } else {
        h += `<p class="cprl-muted">A recorded quantity is negative or unavailable, so no positive stacked bar is drawn.</p>`;
        for (const [label, val] of [['Used', v.used], ['Reserved', v.reserved]]) {
          if (typeof val === 'number' && val < 0) {
            const w = Math.min(100, Math.abs(val) / scale * 100);
            h += `<p>${esc(label)} <strong>${esc(formatValue(val))}</strong> (negative, as recorded)</p><div class="cprl-signed" role="img" aria-label="${esc(label)} ${esc(formatValue(val))}"><div class="cprl-signed-fill" style="width:${w}%"></div></div>`;
          } else h += `<p>${esc(label)} <strong>${esc(formatValue(val))}</strong></p>`;
        }
      }
      h += `<div class="cprl-legend"><span><span class="cprl-sw" style="background:var(--cyan)"></span>Used ${esc(formatValue(v.used))}</span><span><span class="cprl-sw" style="background:var(--amber)"></span>Reserved ${esc(formatValue(v.reserved))}</span>${v.limit !== null ? `<span>Limit ${esc(formatValue(v.limit))}</span>` : ''}<span>Whole-case scale ${esc(formatValue(scale))}</span></div>`;
      if (v.exceeds) h += '<p>Recorded total crosses the limit marker.</p>';
      return h;
    }
    if (v.kind === 'stock') {
      let h = '<h3>Stock and reservations</h3>';
      if (v.comparison.length) h += comparisons(v.comparison.slice(0, 3), 'Expected in recorded check', 'Observed');
      for (const s of v.rows) {
        h += `<p><strong>${esc(s.sku)}</strong></p><div class="cprl-big">${esc(formatValue(s.available))} <span class="cprl-muted" style="font-size:16px">available</span></div>`;
        h += `<p class="cprl-muted">On hand ${esc(formatValue(s.onHand))} · reserved remaining ${esc(formatValue(s.reservedRemaining))} · received ${esc(formatValue(s.received))}${s.overReserved ? ' · reserved exceeds on hand' : ''}</p>`;
        if (s.onHand !== null && s.reservedRemaining !== null) {
          const base = Math.max(s.onHand, s.reservedRemaining, 1);
          h += `<div class="cprl-stack" role="img" aria-label="${esc(s.sku)} on hand ${esc(formatValue(s.onHand))}, reserved ${esc(formatValue(s.reservedRemaining))}"><div class="cprl-seg cprl-seg-used" style="left:0;width:${Math.max(0, s.onHand / base * 100)}%"></div><div class="cprl-seg" style="left:0;width:${Math.max(0, s.reservedRemaining / base * 100)}%;background:repeating-linear-gradient(45deg,var(--amber),var(--amber) 6px,transparent 6px,transparent 12px)"></div></div>`;
        }
      }
      return h;
    }
    if (v.kind === 'version') {
      if (!v.changes.length) return '<h3>Version</h3><p class="cprl-muted">No version field changed in this entry.</p>';
      return '<h3>Version progression</h3>' + comparisons(v.changes) + (v.changes.some(d => d.regressed) ? '<p class="cprl-muted">An older version replaced a newer one.</p>' : '');
    }
    if (v.kind === 'lifecycle') {
      let h = '<h3>Lifecycle</h3>';
      h += v.statusChanges.length ? comparisons(v.statusChanges) : '<p class="cprl-muted">No status change in this entry.</p>';
      h += `<div class="cprl-steps">${v.quantities.slice(0, 3).map(d => `<span>${esc(fieldLabel(d.path.split('.').pop()))} <strong>${esc(formatValue(d.after))}</strong></span>`).join('')}</div>`;
      return h;
    }
    if (v.kind === 'identity') {
      let h = '<h3>Event identity and outcome</h3>';
      h += `<div class="cprl-big">${esc(formatValue(v.eventIdentity ?? v.messageId))}</div>`;
      h += `<p class="cprl-muted">${v.eventIdentity === null ? 'Business identity not recorded' : `${v.occurrences} delivered event${v.occurrences === 1 ? '' : 's'} with this identity`} · ${esc(humanOutcome(v.outcome))}${v.orderId ? ` · ${esc(v.orderId)}` : ''}</p>`;
      h += comparisons(v.conflicts.map(c => ({path: c.field, before: c.recordedValue, after: c.eventValue})), v.conflicts[0]?.recordedPath || 'Earlier evidence', 'This event');
      h += v.stateChanged
        ? comparisons(v.quantities.slice(0, 2)) || '<p>Recorded state changed; see the evidence.</p>'
        : '<p>No recorded state change at this entry.</p>';
      return h;
    }
    // Generic unfamiliar finding: compact before/after of the changed values.
    let h = '<h3>Changed values</h3>';
    if (!v.changes.length) h += f.stateStatus === 'first-recorded'
      ? '<p class="cprl-muted">First recorded state for this case; values are in the evidence disclosure.</p>'
      : '<p class="cprl-muted">No recorded state change in this entry.</p>';
    h += f.stateStatus === 'first-recorded'
      ? v.changes.map(d => `<p class="cprl-muted">${esc(fieldLabel(d.path))}</p><div class="cprl-big">${esc(formatValue(d.after))}</div>`).join('')
      : comparisons(v.changes);
    if (v.changeCount > v.changes.length) h += `<p class="cprl-muted">${v.changeCount - v.changes.length} further changed field${v.changeCount - v.changes.length === 1 ? '' : 's'} in the evidence disclosure.</p>`;
    return h;
  }
  function render() {
    if (!current) return;
    const { data, frames, unattributed } = current;
    frameIndex = controller.index;
    const f = frames[frameIndex] || null;
    els.range.max = String(Math.max(frames.length - 1, 0)); els.range.value = String(frameIndex);
    const empty = frames.length === 0;
    els.range.disabled = empty; els.play.disabled = empty || reduced();
    els.prev.disabled = empty || frameIndex <= 0; els.next.disabled = empty || frameIndex >= frames.length - 1;
    els.jump.disabled = empty || (current.findingFrames.length === 0 && current.actionFindingFrame === null);
    els.counter.textContent = empty ? 'No recorded entries' : `Step ${frameIndex + 1} of ${frames.length}`;
    if (!f) { // empty case: full visual reset, whatever was shown before
      resetStage();
      els.caption.textContent = 'Empty trace — no recorded entries.';
      els.banner.textContent = 'No violation recorded.';
      els.lens.innerHTML = lensHtml(null);
      els.raw.textContent = JSON.stringify(data, null, 1);
      return;
    }
    els.caption.textContent = `${f.eventName} — ${humanOutcome(f.outcome)}`;
    els.eventBox.textContent = f.eventName + (f.messageId ? ` · ${f.messageId}` : '');
    els.changeBox.textContent = !f.stateKnown ? 'State not recorded'
      : f.stateStatus === 'first-recorded' ? 'First recorded state'
      : f.diffs.length ? `${f.diffs.length} recorded field change${f.diffs.length === 1 ? '' : 's'}` : 'No recorded state change';
    els.marker.textContent = ''; els.marker.className = 'cprl-marker';
    if (f.isViolation) {
      const msgs = dedupeViolations(f.violationsHere).map(v => v.message);
      els.banner.textContent = `Detected here: ${msgs.join('; ')}`;
      els.banner.className = 'cprl-banner cprl-bad'; els.flowState.textContent = humanOutcome(f.outcome);
      els.marker.textContent = 'Finding recorded here';
      els.marker.className = 'cprl-marker cprl-on';
    } else if (f.isGroupFinding) {
      const msgs = dedupeViolations(f.groupViolations).map(v => v.message);
      els.banner.textContent = `Group-level finding: ${[...new Set(msgs)].join('; ')}`;
      els.banner.className = 'cprl-banner cprl-warn'; els.flowState.textContent = humanOutcome(f.outcome);
      els.marker.textContent = 'Finding in this action group';
      els.marker.className = 'cprl-marker cprl-on cprl-group';
    } else {
      els.banner.textContent = data.violations.length === 0 ? 'No violation recorded.' : 'No violation attributed to this entry.';
      els.banner.className = 'cprl-banner'; els.flowState.textContent = humanOutcome(f.outcome);
    }
    els.lens.innerHTML = lensHtml(f);
    els.raw.textContent = JSON.stringify({ entry: { step: f.step, action: f.action, outcome: f.outcome, payload: f.payload, state: f.state }, stateStatus: f.stateStatus, diffs: f.diffs, violationsHere: f.violationsHere, groupViolations: f.groupViolations, unattributedViolations: unattributed }, null, 1);
  }
  els.select.addEventListener('change', () => { loadCase(Number(els.select.value)); persist(); });
  els.play.addEventListener('click', () => { if (reduced()) { controller.handleReducedMotion(true); return; } controller.toggle(); persist(); });
  els.prev.addEventListener('click', () => { controller.step(-1); persist(); });
  els.next.addEventListener('click', () => { controller.step(1); persist(); });
  els.range.addEventListener('input', () => { controller.seek(Number(els.range.value)); persist(); });
  els.jump.addEventListener('click', () => { const j = jumpToFinding(current.frames) ?? current.actionFindingFrame; if (j !== null && j !== undefined) { controller.seek(j); persist(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) controller.handleHidden(); });
  try { window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => controller.handleReducedMotion(e.matches)); } catch (e) {}
  window.addEventListener('openai:set_globals', (event) => {
    if (!event.detail?.globals || !Object.hasOwn(event.detail.globals, 'widgetState')) return;
    const active = document.activeElement;
    saved = readSaved(event.detail.globals.widgetState);
    const ci = clampIndex(saved.caseIndex, CASES.length);
    if (ci === caseIndex && saved.frameIndex === frameIndex) return;
    if (ci !== caseIndex) loadCase(ci, saved.frameIndex);
    else { controller.seek(clampIndex(saved.frameIndex, current ? current.frames.length : 0)); render(); }
    if (active && typeof active.focus === 'function' && root.contains(active)) active.focus();
  });
  els.select.innerHTML = CASES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('');
  loadCase(caseIndex, saved.frameIndex);
})();
