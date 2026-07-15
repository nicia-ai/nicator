import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Client, createClient } from "@libsql/client";
import { createRepository, nicatorGraph, type Repository } from "@nicator/core";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

// ---------------------------------------------------------------------------
// Local repo — libsql backend for the local CLI and evals (Node only)
// ---------------------------------------------------------------------------

// libsql's `file::memory:` gives every new connection its own empty database,
// and TypeGraph's transactional schema commit runs on a separate connection —
// the schema it creates is invisible to the caller's connection and every
// subsequent query fails with "no such table". Ephemeral databases therefore
// live in a temp file, removed on process exit.
const ephemeralDbPaths = new Set<string>();
let ephemeralCleanupRegistered = false;

function createEphemeralDbPath(): string {
  const path = join(tmpdir(), `nicator-ephemeral-${randomUUID()}.db`);
  ephemeralDbPaths.add(path);
  if (!ephemeralCleanupRegistered) {
    ephemeralCleanupRegistered = true;
    process.on("exit", () => {
      for (const dbPath of ephemeralDbPaths) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            unlinkSync(dbPath + suffix);
          } catch {
            // Best-effort cleanup; the OS reclaims tmpdir eventually.
          }
        }
      }
    });
  }
  return path;
}

export type LocalRepoResult = Readonly<{
  repo: Repository;
  /** The underlying libsql client — share with agentfs for same-database access. */
  client: Client;
}>;

/**
 * Create a Repository backed by a local libsql database.
 * Pass ":memory:" for an ephemeral database (useful for tests and evals) —
 * backed by a temp file removed on process exit, see above.
 *
 * Returns both the Repository and the raw libsql Client so that other
 * subsystems (e.g. agentfs) can share the same database connection.
 */
export async function createLocalRepo(
  dbPath: string,
): Promise<LocalRepoResult> {
  const url =
    dbPath === ":memory:" ?
      `file:${createEphemeralDbPath()}`
    : `file:${dbPath}`;
  const client = createClient({ url });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(nicatorGraph, backend);
  return { repo: createRepository(store), client };
}
