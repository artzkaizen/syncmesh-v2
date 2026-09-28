import { mockMesh } from "../src/mock/index.js";
import { defaultTabs } from "../src/panels/index.js";
import { mount } from "../src/react/mount.js";

/**
 * The harness: a host page with nothing on it but the bubble, so the panel is the whole subject.
 *
 * It mounts `defaultTabs` — **the same list an app installs**, not a hand-written copy of it — over
 * the package's own fixture source. The fixture is the only stand-in left, because a demo that
 * wires a different panel set than production is a demo that can go green while the product is
 * broken, which is exactly what happened the first time this was looked at.
 *
 * The source is passed as a factory rather than a value: it is called once when the panel opens,
 * which is what keeps the devtool inert while it is closed.
 *
 * `controls` is passed here and is the one prop a production build drops. The fixture's controls
 * act on the fixture's own mediums, so holding `ble` in `radio-off` changes the row, empties the
 * peers it was carrying and marks the bubble — which is the whole loop a real mesh runs, with the
 * mesh taken out. They are built outside the factory because a held medium is a state that must
 * survive closing and reopening the panel; a forced state that quietly released itself when the
 * panel shut would be the least findable bug in the package.
 */
const { source, controls } = mockMesh();

mount({ tabs: defaultTabs, source: () => source, controls, dispose: () => undefined });
