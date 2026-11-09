import { Result } from "@syncmesh/result";

import type { SqlDriver, SqlValue } from "./driver.js";

const SECURE_DELETE = "PRAGMA secure_delete";

/**
 * Runs `statement`, an `UPDATE` that replaces a plaintext secret with its sealed form, with
 * SQLite's `secure_delete` on for that one statement so the old bytes are zeroed in the page
 * rather than left in free space, then checkpoints the WAL so no frame still holds them.
 *
 * Answers what it could not make sure of — a database that refuses the pragma (a Durable Object's
 * SQL surface may), or a WAL that would not checkpoint — as a sentence for the caller's notice,
 * and `undefined` when the plaintext is gone from the file. Throws when the `UPDATE` itself does.
 *
 * @example
 * const residue = await overwritePlaintext(driver, UPDATE, [sealed, "seed"], "device key");
 * if (residue !== undefined) onNotice(residue);
 */
export async function overwritePlaintext(
  driver: SqlDriver,
  statement: string,
  params: readonly SqlValue[],
  what: string,
): Promise<string | undefined> {
  const before = await Result.tryPromise({
    try: async () => (await driver.all(SECURE_DELETE))[0]?.[0],
    catch: (cause) => cause,
  });
  const scrubbing =
    before.isOk() &&
    (
      await Result.tryPromise({
        try: () => driver.run(`${SECURE_DELETE} = ON`),
        catch: (cause) => cause,
      })
    ).isOk();
  await driver.run(statement, params);
  if (scrubbing && before.isOk())
    await driver.run(`${SECURE_DELETE} = ${Number(before.value ?? 0)}`);
  const checkpoint = await Result.tryPromise({
    try: () => driver.all("PRAGMA wal_checkpoint(TRUNCATE)"),
    catch: (cause) => cause,
  });
  if (!scrubbing)
    return `this database refuses PRAGMA secure_delete, so the plaintext ${what}'s old bytes may stay in its free pages until they are reused`;
  if (checkpoint.isErr() || Number(checkpoint.value[0]?.[0] ?? 0) !== 0)
    return `the WAL could not be checkpointed, so a frame of it may hold the plaintext ${what} until the next checkpoint`;
  return undefined;
}
