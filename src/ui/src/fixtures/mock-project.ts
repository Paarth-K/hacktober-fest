import type { CompanionState } from "../lib/contracts";

const now = new Date().toISOString();

export const mockState: CompanionState = {
  project: {
    id: "project-local-companion",
    name: "Local Code Companion",
    rootPath: "/Users/demo/local-code-companion",
    goal: "Build an honest local-first progress and learning companion.",
    checkCommands: [
      { id: "check-ui", command: "npm run test --workspace src/ui" },
      { id: "check-rust", command: "cargo test --manifest-path src-tauri/Cargo.toml" }
    ],
    createdAt: now,
    updatedAt: now
  },
  tasks: [
    {
      id: "task-shell",
      projectId: "project-local-companion",
      title: "Build the floating desktop shell",
      order: 0,
      status: "verified_complete",
      acceptanceCriteria: [
        { id: "criterion-window", text: "Window stays on top and supports compact mode", met: true, metBy: "check", checkCommandId: "check-ui" },
        { id: "criterion-state", text: "Position and size survive relaunch", met: true, metBy: "user" }
      ],
      evidenceIds: ["batch-window"],
      verificationRunIds: ["verify-ui"],
      statusHistory: [{ status: "verified_complete", timestamp: now, reason: "Linked UI check passed" }],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    },
    {
      id: "task-observer",
      projectId: "project-local-companion",
      title: "Connect observed edits to task evidence",
      order: 1,
      status: "activity_detected",
      acceptanceCriteria: [
        { id: "criterion-safe-path", text: "Only safe workspace-relative paths appear", met: false, metBy: "none" },
        { id: "criterion-attribution", text: "Suggestions require user acceptance", met: false, metBy: "none" }
      ],
      evidenceIds: [],
      verificationRunIds: [],
      statusHistory: [{ status: "activity_detected", timestamp: now, reason: "Observed edits; no verification run" }],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    },
    {
      id: "task-learning",
      projectId: "project-local-companion",
      title: "Explain a grounded change",
      order: 2,
      status: "needs_verification",
      acceptanceCriteria: [{ id: "criterion-citation", text: "Every citation resolves inside the workspace", met: false, metBy: "none" }],
      evidenceIds: ["batch-window"],
      verificationRunIds: [],
      statusHistory: [{ status: "needs_verification", timestamp: now, reason: "Explanation available; behavior not checked" }],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    },
    {
      id: "task-report",
      projectId: "project-local-companion",
      title: "Export an evidence-backed report",
      order: 3,
      status: "not_started",
      acceptanceCriteria: [{ id: "criterion-report", text: "Report separates verified and unverified work", met: false, metBy: "none" }],
      evidenceIds: [],
      verificationRunIds: [],
      statusHistory: [{ status: "not_started", timestamp: now, reason: "Task created" }],
      createdAt: now,
      updatedAt: now
    }
  ],
  progress: {
    projectId: "project-local-companion",
    total: 4,
    byStatus: { not_started: 1, activity_detected: 1, needs_verification: 1, verified_complete: 1, user_confirmed: 0 },
    percentComplete: 25,
    criteriaMet: 2,
    criteriaTotal: 6,
    stalledTaskIds: [],
    regressedTaskIds: ["task-learning"],
    lastActivityAt: now,
    computedAt: now
  },
  changes: [{
    id: "batch-window",
    sessionId: "mock-session",
    timestamp: now,
    source: "filesystem",
    changes: [
      { path: "src/ui/src/App.tsx", kind: "modified", hunks: [{ startLine: 22, endLine: 71 }] },
      { path: "src-tauri/src/lib.rs", kind: "created", hunks: [{ startLine: 1, endLine: 94 }] }
    ],
    omissions: [".env excluded by context policy"],
    suggestedTaskLinks: [{ taskId: "task-observer", score: 0.86, reason: "Files implement activity and evidence surfaces" }]
  }],
  verifications: [{
    id: "verify-ui",
    projectId: "project-local-companion",
    taskIds: ["task-shell"],
    command: "npm run test --workspace src/ui",
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    durationMs: 1240,
    outputTail: "3 tests passed",
    result: "pass"
  }],
  explanation: {
    summary: "The window UI now separates observed activity from verified completion.",
    behaviorChanges: ["Observed edits appear as evidence without increasing the completion percentage."],
    concepts: ["Evidence-backed state", "User-mediated attribution"],
    concerns: ["The engine connection is using deterministic mock data."],
    evidence: [{ path: "src/ui/src/App.tsx", startLine: 22, endLine: 71, valid: true }],
    uncertainties: ["Real engine reconnect behavior has not been exercised in mock mode."],
    quiz: { question: "Why does file activity not increase completion?", answer: "Because completion requires a passing linked check or explicit user confirmation." },
    provider: "DeterministicMockProvider",
    mode: "mock"
  },
  breakdown: null,
  preferences: { pinned: true, compact: false, level: "beginner", theme: "system", editorCommand: "code -g" }
};
