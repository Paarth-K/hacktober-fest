/** Read-only facts from P4; this formatter never computes or changes task status. */
export interface ReportSnapshot {
  total: number;
  byStatus: { not_started: number; activity_detected: number; needs_verification: number; verified_complete: number; user_confirmed: number };
  percentComplete: number;
  criteriaMet: number;
  criteriaTotal: number;
}
export function summarizeProgress(snapshot: ReportSnapshot): string {
  const values = [snapshot.total, snapshot.percentComplete, snapshot.criteriaMet, snapshot.criteriaTotal, ...Object.values(snapshot.byStatus)];
  if (values.some(x => !Number.isFinite(x) || x < 0)) throw new Error('Invalid progress snapshot');
  const s = snapshot.byStatus;
  return `${snapshot.percentComplete}% complete as reported by the progress engine. ${s.verified_complete} verified complete; ${s.user_confirmed} user confirmed; ${s.activity_detected} with activity detected; ${s.needs_verification} needing verification; ${s.not_started} not started. ${snapshot.criteriaMet} of ${snapshot.criteriaTotal} criteria met across ${snapshot.total} tasks. Activity does not establish completion.`;
}
