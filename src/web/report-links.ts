import type { ReportUiState } from './finding-explanations.ts';

/** Discoverable links to saved reports; viewing them makes no model call. */

export interface ReportLinksState {
  viewHref: string | null;
  downloadHref: string | null;
  canAccess: boolean;
}

export type ReportSessionKind = ReportUiState['kind'];

export function computeReportLinks(
  runId: string | null,
  sessionKind: ReportSessionKind,
): ReportLinksState {
  if (!runId || sessionKind !== 'saved') {
    return {
      viewHref: null,
      downloadHref: null,
      canAccess: false,
    };
  }

  const encodedId = encodeURIComponent(runId);
  return {
    viewHref: `/api/runs/${encodedId}/explanation-report`,
    downloadHref: `/api/runs/${encodedId}/explanation-report?download=1`,
    canAccess: true,
  };
}

export function computeFindingReportHref(
  runId: string | null,
  findingNumber: number,
  sessionKind: ReportSessionKind,
): string | null {
  if (!runId || sessionKind !== 'saved' || !Number.isInteger(findingNumber) || findingNumber <= 0) {
    return null;
  }
  const encodedId = encodeURIComponent(runId);
  return `/api/runs/${encodedId}/explanation-report#finding-${findingNumber}`;
}
