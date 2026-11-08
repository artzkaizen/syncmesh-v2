import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The DOM the editors render into, registered once per process: `register()` throws if it runs
 * twice, and bun runs every test file of a package in one process.
 */
GlobalRegistrator.register();
