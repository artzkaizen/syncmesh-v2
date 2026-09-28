import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The DOM these tests render into, registered once per process.
 *
 * A module rather than a line in each file: `register()` throws if it runs twice, and bun runs
 * every test file of a package in one process, so the second file to call it would fail the run.
 */
GlobalRegistrator.register();
// SAFETY: React's test flag lives on the global; the registrator just built that global
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
