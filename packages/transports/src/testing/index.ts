/**
 * The parts of this package that exist to test something else.
 *
 * Kept out of the main entry so a device build never carries them, and out of `__tests__` so a
 * chaos rig can reach the same virtual mediums the package's own tests run against — one medium
 * each, so a fault either reproduces is a fault the unit tests can be pointed at.
 */
export { virtualLan, type VirtualLan } from "../lan/virtual-lan.js";
export { virtualFabric, type VirtualFabric } from "../p2p/virtual-fabric.js";
