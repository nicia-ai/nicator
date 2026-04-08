import { type Client, createClient } from "@libsql/client";
import { createRepository, nicatorGraph, type Repository } from "@nicator/core";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

// ---------------------------------------------------------------------------
// Local repo — libsql backend (works in Node, Workers, and browser)
// ---------------------------------------------------------------------------

export type LocalRepoResult = Readonly<{
  repo: Repository;
  /** The underlying libsql client — share with agentfs for same-database access. */
  client: Client;
}>;

/**
 * Create a Repository backed by a local libsql database.
 * Pass ":memory:" for an ephemeral in-memory database (useful for tests and evals).
 *
 * Returns both the Repository and the raw libsql Client so that other
 * subsystems (e.g. agentfs) can share the same database connection.
 */
export async function createLocalRepo(
  dbPath: string,
): Promise<LocalRepoResult> {
  const url = dbPath === ":memory:" ? "file::memory:" : `file:${dbPath}`;
  const client = createClient({ url });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(nicatorGraph, backend);
  return { repo: createRepository(store), client };
}
