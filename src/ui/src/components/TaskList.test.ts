import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadDemoFixture } from "../../../shared/fixtures.js";
import { TaskList } from "./TaskList.js";

describe("TaskList acceptance criteria", () => {
  it("renders readable criterion text and an explicitly named checkbox", () => {
    const fixture = loadDemoFixture();
    const task = fixture.tasks[0]!;
    const html = renderToStaticMarkup(createElement(TaskList, {
      project: fixture.project,
      tasks: [task],
      changes: fixture.changeBatches,
      verifications: fixture.verificationRuns,
      attentionIds: new Set<string>(),
      onSend: () => undefined,
      onOpenFile: () => undefined,
    }));

    expect(html).toContain('value="GET /health returns 200"');
    expect(html).toContain('aria-label="Mark criterion met: GET /health returns 200"');
  });
});
