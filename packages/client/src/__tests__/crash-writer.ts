/**
 * The process the crash tests kill: opens a mesh under the directory it is given and writes
 * one row after another, printing each row's id once its write has committed. Whatever the
 * parent has read from stdout before it sends SIGKILL is what the reopened store must hold.
 */
import { createMesh } from "../mesh.js";
import { notes, notesSchema, writer as device } from "./crash-fixture.js";

const schema = notesSchema();

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("usage: crash-writer <dataDir>");

const mesh = (
  await createMesh({ schema, identity: device, authority: device.peerId, dataDir })
).unwrap();
const handle = mesh.on().unwrap();
for (let i = 1; ; i += 1) {
  await handle.db.insert(notes).values({ id: `n${String(i)}`, body: `row ${String(i)}` });
  console.log(String(i));
}
