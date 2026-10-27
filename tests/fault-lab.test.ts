import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_VARIANTS, type Experiment, type TargetVariant } from '../src/domain.ts';
import {
  computeSourceHash,
  executeExperiment,
  getSourceBundle,
} from '../src/simulator/index.ts';
import {
  FAULT_CATALOG,
  getAllFaultCatalogEntries,
  getFaultCatalogEntry,
  type FaultCatalogEntry,
} from '../src/testing/fault-catalog.ts';

describe('Fault Lab Catalogue and Invariant Reproduction', () => {
  it('contains comprehensive catalog entries for all 9 defect variants', () => {
    expect(FAULT_CATALOG.length).toBe(9);
    const variantsInCatalog = FAULT_CATALOG.map((e) => e.variant);
    for (const v of ['candidate-a', 'candidate-b', 'candidate-c', 'candidate-d', 'candidate-e', 'candidate-f', 'candidate-g', 'candidate-h', 'candidate-i'] as const) {
      expect(variantsInCatalog).toContain(v);
      const entry = getFaultCatalogEntry(v);
      expect(entry).toBeDefined();
      expect(entry?.affectedComponent.length).toBeGreaterThan(0);
      expect(entry?.affectedBehaviour.length).toBeGreaterThan(0);
      expect(entry?.publicInvariantId.length).toBeGreaterThan(0);
      expect(entry?.knownExperiment.steps.length).toBeGreaterThan(0);
      expect(entry?.normalExperiment.steps.length).toBeGreaterThan(0);
    }
  });

  describe.each([
    'candidate-d',
    'candidate-e',
    'candidate-f',
    'candidate-g',
    'candidate-h',
    'candidate-i',
  ] as const)('%s offline catchability and clean contrast', (variant: TargetVariant) => {
    const entry = getFaultCatalogEntry(variant)!;

    it(`reproduces invariant violation [${entry.publicInvariantId}] deterministically while clean control passes`, () => {
      // 1. Clean control must PASS with zero violations and valid=true
      const cleanResult = executeExperiment(entry.knownExperiment, 'clean');
      expect(cleanResult.valid).toBe(true);
      expect(cleanResult.rejections).toHaveLength(0);
      expect(cleanResult.violations).toHaveLength(0);

      // 2. Candidate variant must be a valid experiment execution and trigger expected invariant
      const candidateResult = executeExperiment(entry.knownExperiment, variant);
      expect(candidateResult.valid).toBe(true);
      expect(candidateResult.rejections).toHaveLength(0);
      expect(candidateResult.violations.length).toBeGreaterThan(0);

      const targetViolation = candidateResult.violations.find(
        (v) => v.invariant === entry.publicInvariantId,
      );
      expect(targetViolation).toBeDefined();

      // 3. Exact same-source semantic replay check: re-running gives identical result
      const replayResult = executeExperiment(entry.knownExperiment, variant);
      expect(replayResult.violations).toEqual(candidateResult.violations);
      expect(replayResult.snapshot).toEqual(candidateResult.snapshot);
      expect(replayResult.sourceHash).toEqual(candidateResult.sourceHash);
    });

    it(`passes normal sequence on both ${variant} and clean control`, () => {
      const cleanResult = executeExperiment(entry.normalExperiment, 'clean');
      expect(cleanResult.valid).toBe(true);
      expect(cleanResult.violations).toHaveLength(0);

      const candidateResult = executeExperiment(entry.normalExperiment, variant);
      expect(candidateResult.valid).toBe(true);
      expect(candidateResult.violations).toHaveLength(0);
    });
  });
});

describe('Fault Lab Boundary Coverage Matrix', () => {
  it('covers Candidate D boundary cases (equal / lower / higher market versions)', () => {
    const entry = getFaultCatalogEntry('candidate-d')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // Lower version: clean rejects stale quote; candidate-d mutates and violates version_monotonicity
    const lowerClean = executeExperiment(boundaries.lowerVersion!, 'clean');
    expect(lowerClean.violations).toHaveLength(0);
    const lowerD = executeExperiment(boundaries.lowerVersion!, 'candidate-d');
    expect(lowerD.violations.some((v) => v.invariant === 'version_monotonicity')).toBe(true);

    // Equal version with different price: clean rejects; candidate-d mutates and violates version_monotonicity
    const equalClean = executeExperiment(boundaries.equalVersion!, 'clean');
    expect(equalClean.violations).toHaveLength(0);
    const equalD = executeExperiment(boundaries.equalVersion!, 'candidate-d');
    expect(equalD.violations.some((v) => v.invariant === 'version_monotonicity')).toBe(true);

    // Higher version: both clean and candidate-d accept and succeed
    const higherClean = executeExperiment(boundaries.higherVersion!, 'clean');
    expect(higherClean.violations).toHaveLength(0);
    const higherD = executeExperiment(boundaries.higherVersion!, 'candidate-d');
    expect(higherD.violations).toHaveLength(0);
  });

  it('covers Candidate E boundary cases (equal / lower / higher credit versions)', () => {
    const entry = getFaultCatalogEntry('candidate-e')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // Lower version: clean rejects stale credit; candidate-e mutates and violates version_monotonicity
    const lowerClean = executeExperiment(boundaries.lowerVersion!, 'clean');
    expect(lowerClean.violations).toHaveLength(0);
    const lowerE = executeExperiment(boundaries.lowerVersion!, 'candidate-e');
    expect(lowerE.violations.some((v) => v.invariant === 'version_monotonicity')).toBe(true);

    // Equal version with different limit: clean rejects; candidate-e mutates and violates version_monotonicity
    const equalClean = executeExperiment(boundaries.equalVersion!, 'clean');
    expect(equalClean.violations).toHaveLength(0);
    const equalE = executeExperiment(boundaries.equalVersion!, 'candidate-e');
    expect(equalE.violations.some((v) => v.invariant === 'version_monotonicity')).toBe(true);

    // Higher version: both clean and candidate-e accept and succeed
    const higherClean = executeExperiment(boundaries.higherVersion!, 'clean');
    expect(higherClean.violations).toHaveLength(0);
    const higherE = executeExperiment(boundaries.higherVersion!, 'candidate-e');
    expect(higherE.violations).toHaveLength(0);
  });

  it('covers Candidate F boundary cases (one / split / full fills)', () => {
    const entry = getFaultCatalogEntry('candidate-f')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // One fill: both clean and candidate-f pass (used = notional)
    const oneClean = executeExperiment(boundaries.oneFill!, 'clean');
    expect(oneClean.violations).toHaveLength(0);
    const oneF = executeExperiment(boundaries.oneFill!, 'candidate-f');
    expect(oneF.violations).toHaveLength(0);

    // Split fills: clean accumulates used credit; candidate-f resets used credit and violates credit_exposure_consistency
    const splitClean = executeExperiment(boundaries.splitFills!, 'clean');
    expect(splitClean.violations).toHaveLength(0);
    const splitF = executeExperiment(boundaries.splitFills!, 'candidate-f');
    expect(splitF.violations.some((v) => v.invariant === 'credit_exposure_consistency')).toBe(true);

    // Full fill: both clean and candidate-f pass
    const fullClean = executeExperiment(boundaries.fullFill!, 'clean');
    expect(fullClean.violations).toHaveLength(0);
    const fullF = executeExperiment(boundaries.fullFill!, 'candidate-f');
    expect(fullF.violations).toHaveLength(0);
  });

  it('covers Candidate G boundary cases (locked vs mismatched execution price)', () => {
    const entry = getFaultCatalogEntry('candidate-g')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // Locked price: execution report with matching price passes on both
    const lockedClean = executeExperiment(boundaries.lockedPrice!, 'clean');
    expect(lockedClean.violations).toHaveLength(0);
    const lockedG = executeExperiment(boundaries.lockedPrice!, 'candidate-g');
    expect(lockedG.violations).toHaveLength(0);

    // Mismatched price: clean rejects publicly invalid report; candidate-g accepts and violates input_integrity_no_mutation
    const mismatchedClean = executeExperiment(boundaries.mismatchedPrice!, 'clean');
    expect(mismatchedClean.violations).toHaveLength(0);
    const mismatchedG = executeExperiment(boundaries.mismatchedPrice!, 'candidate-g');
    expect(mismatchedG.violations.some((v) => v.invariant === 'input_integrity_no_mutation')).toBe(true);
  });

  it('covers Candidate H boundary cases (identical vs conflicting business IDs)', () => {
    const entry = getFaultCatalogEntry('candidate-h')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // Identical duplicate: processed idempotently without mutation on both clean and candidate-h
    const idClean = executeExperiment(boundaries.identicalDuplicate!, 'clean');
    expect(idClean.violations).toHaveLength(0);
    const idH = executeExperiment(boundaries.identicalDuplicate!, 'candidate-h');
    expect(idH.violations).toHaveLength(0);

    // Conflicting duplicate: clean rejects conflicting duplicate executionId; candidate-h acknowledges and violates execution_idempotency
    const conflictClean = executeExperiment(boundaries.conflictingDuplicate!, 'clean');
    expect(conflictClean.violations).toHaveLength(0);
    const conflictH = executeExperiment(boundaries.conflictingDuplicate!, 'candidate-h');
    expect(conflictH.violations.some((v) => v.invariant === 'execution_idempotency')).toBe(true);
  });

  it('covers Candidate I boundary cases (partial vs full terminal state)', () => {
    const entry = getFaultCatalogEntry('candidate-i')!;
    const boundaries = entry.boundaryExperiments!;
    expect(boundaries).toBeDefined();

    // Partial fill: clean sets status OPEN; candidate-i sets FILLED and violates lifecycle_consistency
    const partClean = executeExperiment(boundaries.partialFill!, 'clean');
    expect(partClean.violations).toHaveLength(0);
    const partI = executeExperiment(boundaries.partialFill!, 'candidate-i');
    expect(partI.violations.some((v) => v.invariant === 'lifecycle_consistency')).toBe(true);

    // Full fill: both clean and candidate-i set status FILLED and pass
    const fullClean = executeExperiment(boundaries.fullFill!, 'clean');
    expect(fullClean.violations).toHaveLength(0);
    const fullI = executeExperiment(boundaries.fullFill!, 'candidate-i');
    expect(fullI.violations).toHaveLength(0);
  });

  it('safely rejects malformed and fabricated messages without business state mutation', () => {
    const malformedExperiment: Experiment = {
      hypothesis: 'Fabricated structured reports and malformed wire payloads',
      expectedInvariant: 'input_integrity_no_mutation',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Malformed quote (negative price)
        { op: 'send', id: 'm-bad-quote', to: 'market', payload: { type: 'quote', id: 'q2', version: 2, price: -5 } },
        { op: 'deliver', messageId: 'm-bad-quote' },
        // Malformed execution (non-numeric occurredAt)
        { op: 'send', id: 'm-bad-exec', to: 'reports', payload: { type: 'execution', id: 'r1', orderId: 'ord-1', executionId: 'e1', quantity: 1, price: 100, occurredAt: 'yesterday' } },
        { op: 'deliver', messageId: 'm-bad-exec' },
        // Execution for unknown order
        { op: 'send', id: 'm-unknown-exec', to: 'reports', payload: { type: 'execution', id: 'r2', orderId: 'unknown-ord', executionId: 'e2', quantity: 1, price: 100, occurredAt: 1 } },
        { op: 'deliver', messageId: 'm-unknown-exec' },
      ],
    };

    for (const variant of TARGET_VARIANTS) {
      const result = executeExperiment(malformedExperiment, variant);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      const snapshot = (result.snapshot as any).target;
      expect(snapshot.quote.version).toBe(1);
      expect(snapshot.quote.price).toBe(100);
      expect(snapshot.reservedCredit).toBe(0);
      expect(snapshot.usedCredit).toBe(0);
    }
  });
});

describe('Source Isolation and Boundary Rules', () => {
  it('strictly excludes fault-catalog from business code and public contracts', () => {
    const forbiddenPaths = [
      'src/domain.ts',
      'src/simulator/bundle.ts',
      'src/simulator/contract.ts',
      'src/simulator/executor.ts',
      'src/simulator/index.ts',
      'src/simulator/oracle.ts',
      'src/simulator/parser.ts',
      'src/simulator/scheduler.ts',
      'src/simulator/types.ts',
      'src/simulator/venue.ts',
    ];

    for (const relPath of forbiddenPaths) {
      const absPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(absPath)) {
        const content = fs.readFileSync(absPath, 'utf8');
        expect(content).not.toContain('fault-catalog');
        expect(content).not.toContain('FAULT_CATALOG');
        expect(content).not.toContain('fault-lab');
      }
    }

    // Check all variant source code
    for (const variant of TARGET_VARIANTS) {
      const bundle = getSourceBundle(variant);
      for (const file of bundle.files) {
        expect(file.content).not.toContain('fault-catalog');
        expect(file.content).not.toContain('FAULT_CATALOG');
        expect(file.content).not.toContain('fault-lab');
        expect(file.content).not.toContain('knownExperiment');
        expect(file.content).not.toContain('reproducerExperiment');
      }
    }
  });

  it('ensures historical baseline hashes for clean, candidate-a, candidate-b, candidate-c are preserved', () => {
    const historicalHashes: Record<string, string> = {
      clean: '0e1a53f837d80bae744a48ebe9771f2e0b18504ef0ac88bdef5bae1c09ef17f0',
      'candidate-a': '043ee64504bc6f89ab22c61175ebdc5abaf2d7dce8a34fb0a7ac11744fabf9f4',
      'candidate-b': '6ed052be676071fa45b1ab5e68b6c4d61fec470325c06a60a64d85db23695d9d',
      'candidate-c': '79cc2804cb355395d76412c7602c9f2fc2b4eb49eaf27b2e8d42bc6a8bf030d1',
    };

    for (const [variant, expectedHash] of Object.entries(historicalHashes)) {
      const bundle = getSourceBundle(variant as TargetVariant);
      expect(bundle.hash).toBe(expectedHash);
      expect(computeSourceHash(bundle.files)).toBe(expectedHash);
    }
  });
});
