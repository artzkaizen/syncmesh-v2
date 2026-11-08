/**
 * The process the boundary test kills: opens a mesh over {@link boundaryDriver}, commits one row,
 * then writes a second and sends itself SIGKILL just before the `k`th statement of that write
 * reaches SQLite. With `k` 0 it never dies and prints how many statements the write took.
 */
import { createMesh } from "../mesh.js";
import { boundaryDriver, notes, notesSchema, writer as device } from "./crash-fixture.js";

const [dataDir, at] = process.argv.slice(2);
if (dataDir === undefined || at === undefined)
  throw new Error("usage: crash-boundary <dataDir> <k>");
const k = Number(at);

let armed = false;
let seen = 0;
const step = () => {
  if (!armed) return;
  seen += 1;
  if (seen !== k) return;
  process.kill(process.pid, "SIGKILL");
  // the signal is on its way; nothing of this process may run past it
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const mesh = (
  await createMesh({
    schema: notesSchema(),
    identity: device,
    authority: device.peerId,
    dataDir,
    driver: boundaryDriver(dataDir, step),
  })
).unwrap();
const handle = mesh.on().unwrap();
await handle.db.insert(notes).values({ id: "n1", body: "committed before" });
armed = true;
await handle.db.insert(notes).values({ id: "n2", body: "the write the kill lands in" });
armed = false;
console.log(String(seen));
process.exit(0);
