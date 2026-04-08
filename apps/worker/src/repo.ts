import { createRepository, nicatorGraph, type Repository } from "@nicator/core";
import { seedSkillsFromFixtures } from "@nicator/harness";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/sqlite";
import { drizzle } from "drizzle-orm/d1";

import extractClaimsFixture from "../../../fixtures/skills/extract-claims.json";
import factCheckerFixture from "../../../fixtures/skills/fact-checker.json";
import researcherFixture from "../../../fixtures/skills/researcher.json";
import summarizerFixture from "../../../fixtures/skills/summarizer.json";

// ---------------------------------------------------------------------------
// Cached repo (one per isolate, not per request)
//
// D1 bindings are request-scoped: each invocation of env.DB produces an
// independent connection context regardless of JS-level object identity.
// TypeGraph's Store holds only the graph schema and a stateless backend
// reference — no connection or transaction state. The module-level cache
// avoids re-parsing the Zod graph schema and re-seeding skill fixtures on
// every request, not reusing a connection.
//
// The promise (not the resolved value) is cached so concurrent callers
// during initialization share a single init path rather than racing.
// ---------------------------------------------------------------------------

let repoPromise: Promise<Repository> | undefined;

export function getRepo(db: D1Database): Promise<Repository> {
  if (!repoPromise) {
    repoPromise = initRepo(db);
  }
  return repoPromise;
}

async function initRepo(db: D1Database): Promise<Repository> {
  const d1Drizzle = drizzle(db);
  const backend = createSqliteBackend(d1Drizzle, {
    executionProfile: { isSync: false, transactionMode: "none" },
  });
  const [store] = await createStoreWithSchema(nicatorGraph, backend);
  const repo = createRepository(store);
  await seedSkillsFromFixtures(repo, [
    researcherFixture,
    extractClaimsFixture,
    summarizerFixture,
    factCheckerFixture,
  ]);
  return repo;
}
