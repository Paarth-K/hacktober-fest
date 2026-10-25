// Deterministic Markdown progress report. States only what the evidence supports.
import type { ChangeBatch, Project, ProgressSnapshot, Task, VerificationRun } from "../shared/schemas.js";

export interface ReportInput {
  project: Project;
  tasks: Task[];
  snapshot: ProgressSnapshot;
  verificationRuns: VerificationRun[];
  changeBatches: ChangeBatch[];
  /** Optional model-written summary; rendered in a clearly labeled section. */
  aiSummary?: { text: string; provider: string; mode: "real" | "mock" };
  now?: Date;
}

export function generateReport(input: ReportInput): string {
  const { project, tasks, snapshot, verificationRuns } = input;
  const runById = new Map(verificationRuns.map((r) => [r.id, r]));
  const batchById = new Map(input.changeBatches.map((b) => [b.id, b]));
  const sorted = [...tasks].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  const s = snapshot.byStatus;

  lines.push(`# Progress report — ${project.name}`, "");
  lines.push(`Generated ${(input.now ?? new Date()).toISOString()} by Local Code Companion.`, "");
  if (project.goal) lines.push(`**Goal:** ${project.goal}`, "");
  lines.push(
    `**Complete:** ${snapshot.percentComplete}% (${s.verified_complete} verified by checks + ${s.user_confirmed} confirmed by user, of ${snapshot.total} tasks)`,
    `**Acceptance criteria met:** ${snapshot.criteriaMet} of ${snapshot.criteriaTotal}`,
    `**Activity without verification:** ${s.activity_detected} task(s) · **Needs verification:** ${s.needs_verification} · **Not started:** ${s.not_started}`,
    "",
    "_Percent complete counts only tasks verified by a passing check or explicitly confirmed by the user. Detected file activity and AI explanations are not verification._",
    "",
  );

  const files = (t: Task) => {
    const paths = new Set<string>();
    for (const id of t.linkedChangeBatchIds) batchById.get(id)?.changes.forEach((c) => paths.add(`${c.path} (${c.kind})`));
    return [...paths];
  };
  const lastRun = (t: Task) => t.verificationRunIds.map((id) => runById.get(id)).filter((r): r is VerificationRun => !!r).at(-1);
  const runText = (r: VerificationRun) => `\`${r.command}\` → ${r.result}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ""} at ${r.finishedAt ?? r.startedAt}`;

  const section = (title: string, list: Task[], detail: (t: Task) => string[]) => {
    lines.push(`## ${title} (${list.length})`, "");
    if (list.length === 0) lines.push("_None._", "");
    for (const t of list) {
      lines.push(`- **${t.title}**`);
      for (const d of detail(t)) lines.push(`  - ${d}`);
    }
    if (list.length) lines.push("");
  };
  const criteria = (t: Task) =>
    t.acceptanceCriteria.map((c) => `[${c.met ? "x" : " "}] ${c.text}${c.met ? ` — met by ${c.metBy === "check" ? "passing check" : "user"}` : ""}`);
  const lastReason = (t: Task) => t.statusHistory.at(-1)?.reason;

  section("Done", sorted.filter((t) => t.status === "verified_complete" || t.status === "user_confirmed"), (t) => [
    t.status === "verified_complete" ? "Verified by passing check" : "Confirmed manually by user (no automated check)",
    ...criteria(t),
    ...(lastRun(t) ? [`Last check: ${runText(lastRun(t)!)}`] : []),
    ...(files(t).length ? [`Files: ${files(t).join(", ")}`] : []),
  ]);
  section("Needs verification", sorted.filter((t) => t.status === "needs_verification"), (t) => [
    ...(t.regressedAt ? [`⚠ Regression since ${t.regressedAt}`] : []),
    ...(lastReason(t) ? [`Reason: ${lastReason(t)}`] : []),
    ...criteria(t),
    ...(lastRun(t) ? [`Last check: ${runText(lastRun(t)!)}`] : []),
  ]);
  section("In progress — activity detected, not verified", sorted.filter((t) => t.status === "activity_detected"), (t) => [
    ...criteria(t),
    ...(files(t).length ? [`Files touched: ${files(t).join(", ")}`] : []),
    ...(t.lastActivityAt ? [`Last activity: ${t.lastActivityAt}`] : []),
  ]);
  section("Not started", sorted.filter((t) => t.status === "not_started"), criteria);

  const failing = latestPerCheck(verificationRuns).filter((r) => r.result !== "pass");
  lines.push(`## Failing checks (${failing.length})`, "");
  if (failing.length === 0) lines.push(verificationRuns.length ? "_No failing checks in the latest runs._" : "_No checks have been run._", "");
  for (const r of failing) lines.push(`- ${runText(r)}`, "", "```", r.outputTail.slice(-800), "```", "");

  if (input.aiSummary) {
    lines.push(`## Summary (${input.aiSummary.mode === "mock" ? "MOCK — not a real model" : `AI-written by ${input.aiSummary.provider}`}; restates the facts above)`, "", input.aiSummary.text, "");
  }
  return lines.join("\n");
}

function latestPerCheck(runs: VerificationRun[]): VerificationRun[] {
  const m = new Map<string, VerificationRun>();
  for (const r of runs) {
    const prev = m.get(r.checkCommandId);
    if (!prev || r.startedAt >= prev.startedAt) m.set(r.checkCommandId, r);
  }
  return [...m.values()];
}
