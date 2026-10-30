// Regenerates cases.json, coverage.json, candidate-identity.json and replay-lab.html
// from real offline simulator executions. No model calls, no network.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const imp = (p) => import(pathToFileURL(p).href);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const read = (p) => readFileSync(join(root, p), 'utf8');

const { FAULT_CATALOG } = await imp(join(root, 'dist/testing/fault-catalog.js'));
const trading = await imp(join(root, 'dist/simulator/index.js'));
const inventory = await imp(join(root, 'dist/inventory/index.js'));
const { inventoryProposal } = await imp(join(root, 'dist/providers/inventory-mock.js'));

const cases = [];
function pushCase(fields, result) {
  cases.push({ ...fields, experiment: result.experiment ?? fields.experiment ?? null,
    trace: result.trace ?? [], snapshot: result.snapshot ?? {}, violations: result.violations ?? [],
    rejections: result.rejections ?? [], valid: result.valid !== false, sourceHash: result.sourceHash ?? null });
}

// Trading: nine known recipes on their fault variant + same recipe on clean.
// Display names describe these example fixtures only; the renderer never uses
// a fixture ID to choose a view or infer a finding.
const exampleTitles = ['Duplicate fill counted twice', 'Late fill after cancellation', 'Credit limit exceeded', 'Stale quote accepted', 'Stale credit update', 'Split fill undercounted', 'Incorrect execution price', 'Conflicting duplicate accepted', 'Filled status with quantity remaining'];
for (const entry of FAULT_CATALOG) {
  const label = exampleTitles[FAULT_CATALOG.indexOf(entry)];
  pushCase({ id: `trading-${entry.id}`, label, origin: 'known-recipe',
    systemLabel: 'Synthetic trading system (recorded playback)', invariant: entry.publicInvariantId,
    demoNote: 'Recorded simulation · known test case' },
    trading.executeExperiment(entry.knownExperiment, entry.variant));
  pushCase({ id: `trading-${entry.id}-clean`, label: `${label} — clean control`, origin: 'clean-control',
    systemLabel: 'Synthetic trading system (recorded playback)', invariant: entry.publicInvariantId,
    demoNote: 'Recorded simulation · clean control' },
    trading.executeExperiment(entry.knownExperiment, 'clean'));
}
// Inventory: known proposals per fault family + clean controls.
const invPlans = [
  ['inventory-candidate-a', inventoryProposal(1), 'reservation availability'],
  ['inventory-candidate-b', inventoryProposal(0), 'cancellation release'],
  ['inventory-candidate-c', inventoryProposal(2), 'duplicate shipment'],
];
for (const [variant, plan, topic] of invPlans) {
  pushCase({ id: variant, label: `Inventory · ${topic}`,
    origin: 'known-recipe', systemLabel: 'Inventory reservation system (recorded playback)',
    invariant: plan.expectedInvariant, demoNote: 'Recorded simulation · known test case' },
    inventory.executeExperiment(plan, variant));
  pushCase({ id: `${variant}-clean`, label: `Inventory · ${topic} — clean control`,
    origin: 'clean-control', systemLabel: 'Inventory reservation system (recorded playback)',
    invariant: plan.expectedInvariant, demoNote: 'Recorded simulation · clean control' },
    inventory.executeExperiment(plan, 'clean'));
}
// Combined inventory candidate-d: one recipe exercising both fault families.
const combined = { hypothesis: 'Combined cancellation and duplicate shipment probe', expectedInvariant: 'inventory_transition_consistency', steps: [
  { op: 'send', id: 'm1', to: 'stock', payload: { type: 'stock', id: 's1', sku: 'item', quantity: 10 } },
  { op: 'send', id: 'm2', to: 'reservations', payload: { type: 'reserve', id: 'r1', reservationId: 'r1', sku: 'item', quantity: 7 } },
  { op: 'send', id: 'm3', to: 'shipments', payload: { type: 'ship', id: 'sh1', reservationId: 'r1', quantity: 2 } },
  { op: 'send', id: 'm4', to: 'reservations', payload: { type: 'cancel', id: 'c1', reservationId: 'r1' } },
  { op: 'send', id: 'm5', to: 'stock', payload: { type: 'stock', id: 's2', sku: 'other', quantity: 10 } },
  { op: 'send', id: 'm6', to: 'reservations', payload: { type: 'reserve', id: 'r2', reservationId: 'r2', sku: 'other', quantity: 10 } },
  { op: 'send', id: 'm7', to: 'shipments', payload: { type: 'ship', id: 'f1', reservationId: 'r2', quantity: 4 } },
  { op: 'send', id: 'm8', to: 'shipments', payload: { type: 'ship', id: 'f1', reservationId: 'r2', quantity: 4 } },
  { op: 'drain' } ] };
pushCase({ id: 'inventory-candidate-d', label: 'Inventory · combined findings', origin: 'known-recipe',
  systemLabel: 'Inventory reservation system (recorded playback)', invariant: combined.expectedInvariant,
  demoNote: 'Recorded simulation · known test case' }, inventory.executeExperiment(combined, 'inventory-candidate-d'));
pushCase({ id: 'inventory-candidate-d-clean', label: 'Inventory · combined findings — clean control', origin: 'clean-control',
  systemLabel: 'Inventory reservation system (recorded playback)', invariant: combined.expectedInvariant,
  demoNote: 'Recorded simulation · clean control' }, inventory.executeExperiment(combined, 'clean'));

// Synthetic fallback fixtures: separately labelled, never simulator evidence.
function synth(id, label, trace, violations, snapshot = {}) {
  cases.push({ id, label, origin: 'synthetic', systemLabel: 'Synthetic fallback fixture (not simulator evidence)',
    invariant: violations[0]?.invariant ?? null, demoNote: 'Synthetic edge case · design test',
    experiment: null, trace, snapshot, violations, rejections: [], valid: true, sourceHash: null });
}
synth('synthetic-unknown-fields', 'Synthetic · unknown nested fields',
  [{ step: 1, time: 0, action: 'deliver', messageId: 'u1', payload: { type: 'telemetry', widget: { mode: 'auto', flags: { beta: true } }, note: 'opaque' }, outcome: 'delivered:processed', state: { target: { widget: { level: -3, nested: { alpha: 1, label: 'x' } } } } },
   { step: 2, time: 1, action: 'deliver', messageId: 'u2', payload: { type: 'telemetry', widget: { mode: 'manual' } }, outcome: 'delivered:processed', state: { target: { widget: { level: -3, nested: { alpha: 2, label: 'x' } } } } }],
  [{ id: 'sv1', invariant: 'unfamiliar_invariant_xyz', message: 'Synthetic unfamiliar invariant recorded', step: 2, evidence: { alpha: 2 } }]);
synth('synthetic-missing-state', 'Synthetic · known, missing, then known state',
  [{ step: 1, time: 0, action: 'deliver', messageId: 'x1', payload: { type: 'mystery', enabled: false, count: 0 }, outcome: 'delivered:processed', state: { target: { widget: { count: 0, enabled: false, note: null, level: 5 } } } },
   { step: 2, time: 1, action: 'deliver', messageId: 'x2', payload: { type: 'mystery' }, outcome: 'delivered:processed', state: null },
   { step: 3, time: 2, action: 'deliver', messageId: 'x3', payload: { type: 'mystery' }, outcome: 'delivered:processed', state: { target: { widget: { count: 1, enabled: false, note: null, level: 5 } } } }],
  []);
synth('synthetic-ambiguous', 'Synthetic · shared-action ambiguous attribution',
  [{ step: 1, time: 0, action: 'send', messageId: 'a1', payload: { type: 'new_order', orderId: 'ord-9', quantity: 2 }, outcome: 'scheduled', state: { target: { orders: {} } } },
   { step: 2, time: 1, action: 'deliver', messageId: 'a2', payload: { type: 'execution', orderId: 'ord-9', quantity: 2 }, outcome: 'delivered:processed', state: { target: { orders: { 'ord-9': { status: 'OPEN', filledQuantity: 2 } } } } },
   { step: 2, time: 1, action: 'deliver', messageId: 'a3', payload: { type: 'execution', orderId: 'ord-9', quantity: 2 }, outcome: 'delivered:processed', state: { target: { orders: { 'ord-9': { status: 'OPEN', filledQuantity: 4 } } } } }],
  [{ id: 'sv2', invariant: 'execution_idempotency', message: 'Synthetic violation at a shared action', step: 2, orderId: 'ord-9', evidence: {} }]);
synth('synthetic-empty', 'Synthetic · empty trace', [], []);
synth('synthetic-duplicate-neutral', 'Synthetic · duplicate outcome, no violation',
  [{ step: 1, time: 0, action: 'deliver', messageId: 'd1', payload: { type: 'ship', id: 'f1', quantity: 4 }, outcome: 'accepted', state: { target: { shipped: 4 } } },
   { step: 2, time: 1, action: 'deliver', messageId: 'd2', payload: { type: 'ship', id: 'f1', quantity: 4 }, outcome: 'duplicate', state: { target: { shipped: 4 } } }],
  []);
synth('synthetic-two-entities', 'Synthetic · two entities, negative balance',
  [{ step: 1, time: 0, action: 'deliver', messageId: 't1', payload: { type: 'transfer', from: 'acct-a', to: 'acct-b', amount: 15 }, outcome: 'delivered:processed', state: { target: { accounts: { 'acct-a': { balance: -5 }, 'acct-b': { balance: 25 } } } } }],
  [{ id: 'sv3', invariant: 'balance_non_negative', message: 'Synthetic negative balance recorded', step: 1, evidence: { account: 'acct-a', balance: -5 } }]);

const casesJson = JSON.stringify({ generatedFrom: 'offline simulator execution via dist APIs', cases }, null, 1);
writeFileSync(join(here, 'cases.json'), casesJson + '\n');

// Fragment: embed core (exports stripped) + data + UI script.
const coreSrc = readFileSync(join(here, 'replay-core.mjs'), 'utf8').replace(/^export /gm, '');
const uiSrc = readFileSync(join(here, 'replay-ui.js'), 'utf8');
const template = readFileSync(join(here, 'replay-template.html'), 'utf8');
const dataJson = JSON.stringify({ cases }).replaceAll('</script', '<\\/script');
const fragment = template
  .replace('/*__CORE__*/', () => coreSrc)
  .replace('/*__DATA__*/', () => `const CASES = ${dataJson}.cases;`)
  .replace('/*__UI__*/', () => uiSrc);
writeFileSync(join(here, 'replay-lab.html'), fragment);

// Coverage + identity (fragment hash computed after write).
const { buildFrames, creditView, stockView } = await imp(join(here, 'replay-core.mjs'));
const coverageCases = cases.map(c => {
  const built = buildFrames(c);
  const { frames, unattributed, findingFrames, actionFindingFrame, groupFrames } = built;
  const last = frames.at(-1);
  // Executed during generation (real pass/fail), distinct from the
  // descriptive claims below and from the focused test file's assertions.
  const executedChecks = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let creditOk = true, stockOk = true, missingOk = true;
  frames.forEach((f, i) => {
    const raw = c.trace[i]?.state ?? null;
    if (!eq(f.credit, f.stateKnown ? creditView(raw) && { ...creditView(raw), scaleMax: f.credit?.scaleMax } : null) && f.credit !== (creditView(raw))) {
      // creditView equality modulo the scaleMax the projector annotates
      const rc = creditView(raw); if (!eq(f.credit && { ...f.credit, scaleMax: undefined }, rc && { ...rc, scaleMax: undefined })) creditOk = false;
    }
    if (!eq(f.stock, stockView(raw))) stockOk = false;
    if (!f.stateKnown && (f.diffs.length !== 0 || f.visual.kind !== 'not-recorded')) missingOk = false;
  });
  executedChecks.push({ check: 'frame credit/stock projections equal independently recomputed views of the raw entry state', status: creditOk && stockOk ? 'passed' : 'failed' });
  executedChecks.push({ check: 'missing-state frames carry no diffs and a not-recorded visual', status: missingOk ? 'passed' : 'failed' });
  executedChecks.push({ check: 'unique-attribution frames are exactly the frames marked isViolation', status: eq(findingFrames, frames.filter(f => f.isViolation).map(f => f.index)) ? 'passed' : 'failed' });
  executedChecks.push({ check: 'group frames are exactly the unattributed violations recorded steps', status: eq(groupFrames, frames.filter(f => f.isGroupFinding).map(f => f.index)) ? 'passed' : 'failed' });
  const findingFrameDetails = [...new Set([...findingFrames, ...groupFrames])].map(i => {
    const f = frames[i];
    return { frame: i, step: f.step, lens: f.lens, visualKind: f.visual?.kind ?? null,
      isViolation: f.isViolation, isGroupFinding: f.isGroupFinding,
      visual: f.visual?.kind === 'capacity' ? { used: f.visual.used, reserved: f.visual.reserved, total: f.visual.total, limit: f.visual.limit, scaleMax: f.visual.scaleMax }
        : f.visual?.kind === 'version' ? { changes: f.visual.changes }
        : f.visual?.kind === 'lifecycle' ? { statusChanges: f.visual.statusChanges, quantities: f.visual.quantities }
        : f.visual?.kind === 'identity' ? { eventIdentity: f.visual.eventIdentity, occurrences: f.visual.occurrences, outcome: f.visual.outcome, stateChanged: f.visual.stateChanged, conflicts: f.visual.conflicts }
        : f.visual?.kind === 'stock' ? { rows: f.visual.rows }
        : { changes: f.visual?.changes ?? [], stateStatus: f.stateStatus } };
  });
  return { id: c.id, origin: c.origin, invariant: c.invariant, traceEntries: c.trace.length,
    violationsRecorded: c.violations.length, violationInvariants: [...new Set(c.violations.map(v => v.invariant))],
    categories: [...new Set(c.violations.map(v => v.category).filter(Boolean))],
    attributedFindingFrames: findingFrames, groupFrames, actionFindingFrame, unattributedViolations: unattributed.map(v => v.id),
    lensesUsed: [...new Set(frames.map(f => f.lens))], findingFrameDetails,
    finalSnapshot: c.snapshot, lastFrameCredit: last?.credit ?? null, lastFrameStock: last?.stock ?? null,
    executedChecks,
    claims: ['descriptive only (not executed here): values in frames are projected from trace entry state/payload only',
      'descriptive only: only uniquely attributed violations mark a frame; shared-action findings stay group-level',
      'focused-test assertions live in replay-lab.test.mjs and run via node --test'] };
});
let head = 'unknown';
try { head = execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const identity = { baseHead: head,
  hashes: { 'replay-core.mjs': sha(readFileSync(join(here, 'replay-core.mjs'), 'utf8')),
    'generate.mjs': sha(readFileSync(join(here, 'generate.mjs'), 'utf8')),
    'replay-ui.js': sha(uiSrc), 'replay-template.html': sha(template),
    'cases.json': sha(casesJson), 'replay-lab.html': sha(fragment) },
  fragmentBytes: Buffer.byteLength(fragment), caseCount: cases.length };
writeFileSync(join(here, 'candidate-identity.json'), JSON.stringify(identity, null, 2) + '\n');
writeFileSync(join(here, 'coverage.json'), JSON.stringify({ identity, cases: coverageCases }, null, 1) + '\n');
console.log(`cases=${cases.length} fragmentBytes=${identity.fragmentBytes} head=${head}`);
for (const c of coverageCases) console.log(c.id, 'viol=' + c.violationsRecorded, 'frames=' + JSON.stringify(c.attributedFindingFrames), 'unattr=' + c.unattributedViolations.length, 'lenses=' + c.lensesUsed.join(','));
