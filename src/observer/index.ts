// OWNED BY P2 (feature/code-observer). Local edit observer: watches the workspace,
// emits ChangeBatches, builds bounded context packets. See README.md in this folder.
import type { Observer } from "../shared/index.js";
import { LocalObserver, type ObserverOptions } from "./observer.js";

export function createObserver(options?: ObserverOptions): Observer & LocalObserver {
  return new LocalObserver(options);
}

export { LocalObserver };
export type { ObserverOptions, ObserverStatus } from "./observer.js";
export { DEMO_TASKS, MULTI_FILE_FIXTURE } from "./fixtures.js";
export type { FixtureFile, ObserverFixture } from "./fixtures.js";
export { classifyPath, looksBinary } from "./ignore.js";
export type { IgnoreReason } from "./ignore.js";
export { toWorkspaceRel } from "./paths.js";
