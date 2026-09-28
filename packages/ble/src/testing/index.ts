/**
 * The parts of this package that exist to test something else.
 *
 * Kept out of the main entry so a device build never carries them, and out of `__tests__` so the
 * chaos rig can reach the same virtual air the package's own tests run against — one medium, so a
 * fault it reproduces is a fault the unit tests can be pointed at.
 */
export { virtualAir, type VirtualAir } from "./virtual-air.js";
