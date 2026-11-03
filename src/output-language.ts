/**
 * Output language preference, validation, preset definitions, and dictionary helpers.
 *
 * Supported presets: English ('en') and Español ('es').
 * Arbitrary model-supported languages are accepted as canonical language tags or recognized aliases.
 */

export interface OutputLanguagePreset {
  tag: string;
  displayName: string;
}

export const OUTPUT_LANGUAGE_PRESETS: readonly OutputLanguagePreset[] = [
  { tag: 'en', displayName: 'English' },
  { tag: 'es', displayName: 'Español' },
] as const;

export const DEFAULT_OUTPUT_LANGUAGE = 'en';

const MAX_LANGUAGE_LENGTH = 50;

// Only explicit human aliases are accepted; arbitrary prose is not a language.
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en', english: 'en', spa: 'es', spanish: 'es', espanol: 'es', español: 'es',
  french: 'fr', german: 'de', portuguese: 'pt', japanese: 'ja', chinese: 'zh',
};
const FORBIDDEN_CHARS_REGEX = /[\r\n\t\0<>"'`{}|\\^~[\];]/;
const LANGUAGE_TAG_REGEX = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

const COMMON_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ru: 'Russian',
  nl: 'Dutch',
  ar: 'Arabic',
  hi: 'Hindi',
  pl: 'Polish',
  sv: 'Swedish',
};

/** Missing API values retain English. Custom UI blanks are rejected separately. */
export function normalizeOutputLanguage(input: unknown): string {
  if (input === undefined || input === null || input === '') return DEFAULT_OUTPUT_LANGUAGE;
  if (typeof input !== 'string') throw new Error('Language must be a non-empty string.');
  if (input.length > MAX_LANGUAGE_LENGTH) throw new Error(`Language exceeds maximum length of ${MAX_LANGUAGE_LENGTH} characters.`);
  if (FORBIDDEN_CHARS_REGEX.test(input)) throw new Error('Language contains invalid characters or control characters.');
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_OUTPUT_LANGUAGE;
  const tag = LANGUAGE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  if (LANGUAGE_TAG_REGEX.test(tag)) {
    try { return Intl.getCanonicalLocales(tag)[0]!; } catch { /* use the validation error below */ }
  }
  throw new Error('Invalid language tag. Use a standard tag such as fr, es-MX or pt-BR, or a recognized alias such as French.');
}

export function baseOutputLanguage(language: string): string {
  return normalizeOutputLanguage(language).split('-')[0]!;
}

/**
 * Returns human-readable display name for a language tag or name.
 */
export function getLanguageDisplayName(lang: string): string {
  const normalized = normalizeOutputLanguage(lang);
  const lower = normalized.toLowerCase();
  if (COMMON_LANGUAGE_NAMES[lower]) {
    return COMMON_LANGUAGE_NAMES[lower]!;
  }
  const primarySubtag = lower.split('-')[0];
  if (primarySubtag && COMMON_LANGUAGE_NAMES[primarySubtag]) {
    return COMMON_LANGUAGE_NAMES[primarySubtag]!;
  }

  // Capitalize first letter of each word if plain name
  return normalized
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Builds the explicit model prompt instruction for human-readable output prose.
 * Executable syntax, schema keys, and identifiers are strictly constrained to remain untranslated.
 */
export function buildLanguagePromptInstruction(lang: string): string {
  const normalized = normalizeOutputLanguage(lang);
  if (normalized === 'en') {
    return '';
  }

  const displayName = getLanguageDisplayName(normalized);
  return [
    `OUTPUT LANGUAGE REQUIREMENT:`,
    `You must provide all human-readable natural language prose (specifically hypotheses, descriptions, and summary explanations) in ${displayName} (${normalized}).`,
    `JSON property keys, action operation names ("send", "deliver", "duplicate", "advance", "drain", "fill", "confirm_cancel"), recipient channel names ("market", "credit", "client", "reports", "stock", "reservations", "shipments"), payload schema fields, contract invariant IDs, and executable step identifiers MUST remain exact and untranslated in English as defined by the system contract.`
  ].join('\n');
}

/**
 * Report fixed labels dictionary for static and model-translated localization.
 */
export interface ReportFixedLabels {
  eyebrow: string;
  title: string;
  candidateFindingsSuffix: string;
  offlineSourceLabel: string;
  metaSourceLabelTemplate: string; // contains {model}
  runIdentitySummary: string;
  runLabel: string;
  runStatusLabel: string;
  targetLabel: string;
  providerModeLabel: string;
  modelRecordedLabel: string;
  systemLabel: string;
  revisionLabel: string;
  startedLabel: string;
  finishedLabel: string;
  notRecordedLabel: string;
  reportProvenanceSummary: string;
  generatedLabel: string;
  evidenceHashLabel: string;
  sourceHashLabel: string;
  findingsIncludedLabel: string;
  runIncompleteWarningTemplate: string; // contains {status} and {reason}
  snapshotDisclaimer: string;
  navAriaLabel: string;
  findingPrefix: string;
  modelNarrationTag: string;
  whatWasTestedAndWhy: string;
  recordedHypothesis: string;
  expectedRecorded: string;
  observedViolationRecorded: string;
  categoryLabel: string;
  recordedDifferences: string;
  whatChangedHeader: string;
  expectedHeader: string;
  observedHeader: string;
  detailShortenedNote: string;
  whatHappenedNarration: string;
  recordedActionSequence: string;
  noRecordedActions: string;
  stepsTruncatedWarning: string;
  recordedActionData: string;
  recordedTraceData: string;
  recordedTraceSummaryTemplate: string; // contains {count}
  noRecordedTrace: string;
  recordedOutcomeAndArtifact: string;
  findingReproductionLabel: string;
  experimentReplayLabel: string;
  findingCleanControlLabel: string;
  experimentCleanControlLabel: string;
  verifiedRecorded: string;
  notVerifiedRecorded: string;
  passedRecorded: string;
  notPassedRecorded: string;
  unknownNotRecorded: string;
  evidenceNoteLabel: string;
  identifiersSummary: string;
  findingIdLabel: string;
  findingSourceLabel: string;
  experimentIndexLabel: string;
  resolvedPositionLabel: string;
}

export const ENGLISH_REPORT_LABELS: Readonly<ReportFixedLabels> = Object.freeze({
  eyebrow: 'ChaosPilot · Recorded findings',
  title: 'What the investigation found',
  candidateFindingsSuffix: 'candidate finding(s)',
  offlineSourceLabel:
    'Offline scripted explanation — not Muse. Generated deterministically from recorded evidence; no model was called and no usage was incurred. Original recorded evidence retains its original language.',
  metaSourceLabelTemplate:
    'Model narration by Muse ({model}) via the Meta API. Narration is labelled interpretation; expected, observed, replay and clean-control facts come only from the recorded evidence. Original recorded evidence retains its original language.',
  runIdentitySummary: 'Run identity and recorded context',
  runLabel: 'Run',
  runStatusLabel: 'Run status',
  targetLabel: 'Target',
  providerModeLabel: 'Provider/mode',
  modelRecordedLabel: 'Model recorded',
  systemLabel: 'System',
  revisionLabel: 'revision',
  startedLabel: 'Started',
  finishedLabel: 'Finished',
  notRecordedLabel: 'not recorded',
  reportProvenanceSummary: 'Report provenance and identifiers',
  generatedLabel: 'Generated',
  evidenceHashLabel: 'Evidence hash',
  sourceHashLabel: 'Source hash',
  findingsIncludedLabel: 'Findings included: {count} (every recorded finding; none silently omitted)',
  runIncompleteWarningTemplate: 'This run is {status}; its evidence may be incomplete. {reason}',
  snapshotDisclaimer:
    'This report is a saved snapshot of the recorded evidence above. It is not a fresh reproduction and does not claim replay beyond what the record states.',
  navAriaLabel: 'Findings',
  findingPrefix: 'Finding',
  modelNarrationTag: 'Model/script narration — interpretation',
  whatWasTestedAndWhy: 'What was tested and why',
  recordedHypothesis: 'Recorded hypothesis',
  expectedRecorded: 'Expected (recorded)',
  observedViolationRecorded: 'Observed violation (recorded)',
  categoryLabel: 'Category',
  recordedDifferences: 'Recorded differences',
  whatChangedHeader: 'What changed',
  expectedHeader: 'Expected',
  observedHeader: 'Observed',
  detailShortenedNote: 'Some detail is shortened here; the full recorded evidence is available below.',
  whatHappenedNarration: 'What happened (narration)',
  recordedActionSequence: 'Recorded action sequence',
  noRecordedActions: 'No recorded actions are available for this finding.',
  stepsTruncatedWarning: 'Recorded steps were truncated for display; the finding itself is still included.',
  recordedActionData: 'Recorded action data',
  recordedTraceData: 'Recorded trace data',
  recordedTraceSummaryTemplate: 'Recorded execution trace ({count} entries)',
  noRecordedTrace: 'No recorded trace is available.',
  recordedOutcomeAndArtifact: 'Recorded outcome and finding replay artifact',
  findingReproductionLabel: 'Finding reproduction',
  experimentReplayLabel: 'Experiment replay',
  findingCleanControlLabel: 'Finding clean control',
  experimentCleanControlLabel: 'Experiment clean control',
  verifiedRecorded: 'verified (recorded)',
  notVerifiedRecorded: 'not verified (recorded)',
  passedRecorded: 'passed (recorded)',
  notPassedRecorded: 'not passed (recorded)',
  unknownNotRecorded: 'unknown / not recorded',
  evidenceNoteLabel: 'Evidence note',
  identifiersSummary: 'Identifiers',
  findingIdLabel: 'Finding ID',
  findingSourceLabel: 'Finding source',
  experimentIndexLabel: 'Experiment index',
  resolvedPositionLabel: 'Resolved position',
});

export const SPANISH_REPORT_LABELS: Readonly<ReportFixedLabels> = Object.freeze({
  eyebrow: 'ChaosPilot · Hallazgos registrados',
  title: 'Resultados de la investigación',
  candidateFindingsSuffix: 'hallazgo(s) candidato(s)',
  offlineSourceLabel:
    'Explicación programada sin conexión — no es Muse. Generada de forma determinista a partir de la evidencia registrada; no se llamó a ningún modelo ni se incurrió en costos. La evidencia original conserva su idioma registrado.',
  metaSourceLabelTemplate:
    'Narración del modelo por Muse ({model}) a través de la API de Meta. La narración se etiqueta como interpretación; los datos esperados, observados, de reproducción y del control limpio provienen únicamente de la evidencia registrada. La evidencia original conserva su idioma registrado.',
  runIdentitySummary: 'Identidad de la ejecución y contexto registrado',
  runLabel: 'Ejecución',
  runStatusLabel: 'Estado de la ejecución',
  targetLabel: 'Objetivo',
  providerModeLabel: 'Proveedor/modo',
  modelRecordedLabel: 'Modelo registrado',
  systemLabel: 'Sistema',
  revisionLabel: 'revisión',
  startedLabel: 'Iniciado',
  finishedLabel: 'Finalizado',
  notRecordedLabel: 'no registrado',
  reportProvenanceSummary: 'Procedencia del informe e identificadores',
  generatedLabel: 'Generado',
  evidenceHashLabel: 'Hash de evidencia',
  sourceHashLabel: 'Hash de código fuente',
  findingsIncludedLabel: 'Hallazgos incluidos: {count} (todos los hallazgos registrados; ninguno omitido en silencio)',
  runIncompleteWarningTemplate: 'Esta ejecución está {status}; su evidencia puede estar incompleta. {reason}',
  snapshotDisclaimer:
    'Este informe es una instantánea guardada de la evidencia registrada anteriormente. No es una reproducción nueva y no afirma una reproducción más allá de lo que indica el registro.',
  navAriaLabel: 'Hallazgos',
  findingPrefix: 'Hallazgo',
  modelNarrationTag: 'Narración del modelo/guion — interpretación',
  whatWasTestedAndWhy: 'Qué se probó y por qué',
  recordedHypothesis: 'Hipótesis registrada',
  expectedRecorded: 'Esperado (registrado)',
  observedViolationRecorded: 'Violación observada (registrada)',
  categoryLabel: 'Categoría',
  recordedDifferences: 'Diferencias registradas',
  whatChangedHeader: 'Qué cambió',
  expectedHeader: 'Esperado',
  observedHeader: 'Observado',
  detailShortenedNote: 'Parte del detalle se ha resumido aquí; la evidencia registrada completa está disponible abajo.',
  whatHappenedNarration: 'Qué sucedió (narración)',
  recordedActionSequence: 'Secuencia de acciones registrada',
  noRecordedActions: 'No hay acciones registradas disponibles para este hallazgo.',
  stepsTruncatedWarning: 'Los pasos registrados se truncaron para la visualización; el hallazgo en sí aún está incluido.',
  recordedActionData: 'Datos de acción registrados',
  recordedTraceData: 'Datos de traza registrados',
  recordedTraceSummaryTemplate: 'Traza de ejecución registrada ({count} entradas)',
  noRecordedTrace: 'No hay traza registrada disponible.',
  recordedOutcomeAndArtifact: 'Resultado registrado y artefacto de reproducción del hallazgo',
  findingReproductionLabel: 'Reproducción del hallazgo',
  experimentReplayLabel: 'Reproducción del experimento',
  findingCleanControlLabel: 'Control limpio del hallazgo',
  experimentCleanControlLabel: 'Control limpio del experimento',
  verifiedRecorded: 'verificado (registrado)',
  notVerifiedRecorded: 'no verificado (registrado)',
  passedRecorded: 'aprobado (registrado)',
  notPassedRecorded: 'no aprobado (registrado)',
  unknownNotRecorded: 'desconocido / no registrado',
  evidenceNoteLabel: 'Nota de evidencia',
  identifiersSummary: 'Identificadores',
  findingIdLabel: 'ID del hallazgo',
  findingSourceLabel: 'Fuente del hallazgo',
  experimentIndexLabel: 'Índice del experimento',
  resolvedPositionLabel: 'Posición resuelta',
});

/**
 * Obtains static dictionary labels for English or Spanish, or null for custom languages.
 */
export function getStaticReportLabels(lang: string): ReportFixedLabels | null {
  const normalized = baseOutputLanguage(lang);
  if (normalized === 'en') return { ...ENGLISH_REPORT_LABELS };
  if (normalized === 'es') return { ...SPANISH_REPORT_LABELS };
  return null;
}

/**
 * Validates model-returned fixed labels for custom languages.
 */
export function validateCustomReportLabels(raw: unknown): ReportFixedLabels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Model explanation labels did not match the required dictionary structure.');
  }

  const o = raw as Record<string, unknown>;
  const result: Partial<ReportFixedLabels> = {};
  if (Object.keys(o).length !== Object.keys(ENGLISH_REPORT_LABELS).length) throw new Error('Model explanation labels has an invalid or missing dictionary key.');
  const requiredKeys = Object.keys(ENGLISH_REPORT_LABELS) as (keyof ReportFixedLabels)[];

  for (const k of requiredKeys) {
    const val = o[k];
    if (typeof val !== 'string' || !val.trim() || val.length > 500) {
      throw new Error(`Model explanation labels has an invalid or missing "${k}" label.`);
    }
    const placeholders = (value: string) => (value.match(/\{[^{}]*\}/g) ?? []).sort().join('|');
    if (placeholders(val) !== placeholders(ENGLISH_REPORT_LABELS[k]) || /[{}]/.test(val.replace(/\{[^{}]*\}/g, ''))) {
      throw new Error(`Model explanation label "${k}" must preserve its exact template placeholders.`);
    }
    result[k] = val.trim();
  }

  return result as ReportFixedLabels;
}
