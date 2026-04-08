# Storage query patterns

Annotated examples of the TypeGraph query patterns used in
`packages/core/src/repository.ts`. Each pattern shows what it does, when
it's used, and the TypeGraph API calls involved.

All queries go through the `Repository` interface. Domain code never calls
TypeGraph directly.

---

## 1. Single node lookup

Get a run by ID, resolving its `agentDefinitionId` and `agentDefinitionVersion`
from the `instantiates` edge rather than stored properties.

```typescript
const node = await this.store.nodes.Run.getById(asRunNodeId(id));

const edges = await this.store
  .query()
  .from("Run", "r")
  .traverse("instantiates", "e")
  .to("AgentDefinition", "d")
  .whereNode("r", (r) => r.id.eq(id))
  .select((ctx) => ({ definitionId: ctx.d.id, version: ctx.e.version }))
  .execute();
```

**Key points:**

- `getById` fetches node properties. The traversal fetches the relationship.
- `ctx.e.version` accesses a property on the edge itself — edge properties
  are first-class in TypeGraph.
- Relationship fields (`agentDefinitionId`, `agentDefinitionVersion`) are
  never stored on the node. They are always recovered from the edge.

---

## 2. Ordered listing with pagination

List recent runs, ordered by creation time, with a page size limit.

```typescript
const results = await this.store
  .query()
  .from("Run", "r")
  .traverse("instantiates", "e")
  .to("AgentDefinition", "d")
  .orderBy("r", "createdAt", "desc")
  .select((ctx) => ({
    run: ctx.r,
    definitionId: ctx.d.id,
    version: ctx.e.version,
  }))
  .paginate({ first: limit });

// results.data contains the page; results.pageInfo has cursor info
```

**Key points:**

- `orderBy` takes an alias (`"r"`), field name, and direction.
- `paginate({ first: N })` replaces `.execute()` and returns a page object.
- The traversal joins the definition in the same query — no secondary lookup.

---

## 3. Filtering nodes by property

Link a subagent task to its skill via `tasks.linkSkill()`. The skill version
is resolved via the `invokes` edge — it does not live on the Task node.

```typescript
// After creating a skill subagent task, link it to the Skill node
await repo.tasks.linkSkill(childTaskId, skill.id);
```

**Key points:**

- Only skill-backed subagents get an `invokes` edge.
- The Skill node is looked up by its graph ID (returned by `resolveSkill()`).
- `whereNode` filters on node properties. The callback receives a typed
  filter builder — `s.name.eq(...)` produces an equality predicate.
- For high-cardinality lookups, use a compound `whereNode` or a unique
  constraint (see `skill_name_version` in `graph.ts`).

---

## 4. Multi-hop traversal

Get all artifacts produced across an entire run — three hops from Run through
Task and Operation to Artifact.

```typescript
const results = await this.store
  .query()
  .from("Run", "r")
  .traverse("contains", "ce")
  .to("Task", "t")
  .traverse("has_operation", "he")
  .to("Operation", "op")
  .traverse("produces", "pe")
  .to("Artifact", "art")
  .whereNode("r", (r) => r.id.eq(runId))
  .select((ctx) => ({
    artifact: ctx.art,
    taskId: ctx.t.id,
    operationId: ctx.op.id,
  }))
  .execute();
```

**Key points:**

- Traversals chain: `.traverse().to().traverse().to()...`
- Each step gets its own alias (`"ce"`, `"he"`, `"pe"`) for the edge and
  (`"t"`, `"op"`, `"art"`) for the target node.
- The `select` can reference any alias in the chain — here it pulls the
  artifact plus the IDs of intermediate nodes for provenance reconstruction.

---

## 5. Inbound traversal (reverse direction)

Trace an artifact back to the operation that produced it — walking edges in
reverse.

```typescript
const producerRows = await this.store
  .query()
  .from("Operation", "op")
  .traverse("produces", "pe")
  .to("Artifact", "art")
  .whereNode("art", (art) => art.id.eq(artifactId))
  .select((ctx) => ({ operationId: ctx.op.id }))
  .execute();
```

**Key points:**

- The query starts from the source node type (`Operation`) and traverses
  forward to `Artifact`, then filters on the artifact ID. TypeGraph resolves
  this efficiently.
- This is the building block for the full provenance chain: Artifact ←
  Operation ← Task ← Run, each step a separate query in the current
  implementation.

---

## 6. Batch queries

Execute multiple independent queries in a single round-trip.

```typescript
const skillQuery = this.store
  .query()
  .from("Task", "t")
  .traverse("invokes", "e")
  .to("Skill", "s")
  .whereNode("t", (t) => t.id.eq(task.id))
  .select((ctx) => ctx.s);

const consumesQuery = this.store
  .query()
  .from("Task", "t")
  .traverse("consumes", "ce")
  .to("Artifact", "art")
  .whereNode("t", (t) => t.id.eq(task.id))
  .select((ctx) => ({ artifactId: ctx.art.id }));

const [skillResults, consumedResults] = await this.store.batch(
  skillQuery,
  consumesQuery,
);
```

**Key points:**

- `store.batch()` takes multiple query builders (without `.execute()`) and
  runs them together.
- Results are returned as a typed tuple — `skillResults` and
  `consumedResults` have their own types.
- Used in `getRunLineage` to avoid sequential round-trips when fetching
  skill and artifact data for each task.

---

## 7. Node creation with edges

Create a task node and connect it to its run via a `contains` edge.

```typescript
const taskNode = await this.store.nodes.Task.create(
  { role, subagentName, status, input, createdAt, updatedAt },
  { id: task.id },
);

const runNode = await this.store.nodes.Run.getById(asRunNodeId(task.runId));
if (runNode) {
  await this.store.edges.contains.create(runNode, taskNode, {
    sequenceNumber: task.sequenceNumber,
  });
}
```

**Key points:**

- `nodes.Task.create(properties, options)` creates the node. The second
  argument sets the ID explicitly (UUIDs generated by the harness).
- `edges.contains.create(fromNode, toNode, edgeProperties)` creates a typed
  edge. Edge properties (like `sequenceNumber`) are passed as the third
  argument.
- Node creation and edge creation are separate calls. The node must exist
  before an edge can reference it.

---

## 8. Node updates

Patch a subset of properties on an existing node.

```typescript
const updates = pickDefined({
  status: patch.status,
  output: patch.output,
  error: patch.error,
  updatedAt: patch.updatedAt,
});

if (Object.keys(updates).length === 0) return;

await this.store.nodes.Run.update(asRunNodeId(id), updates);
```

**Key points:**

- `nodes.Run.update(nodeId, partialProperties)` merges the provided
  properties into the existing node.
- `pickDefined` (a local utility) strips `undefined` values so only
  explicitly set fields are updated.
- The branded `NodeId<T>` type ensures you cannot accidentally pass a Task
  ID to a Run update call.

## 9. Content-address dedup

Find an existing artifact with the same `contentHash` within a run. If one
exists, the caller links the existing node to the producing operation instead
of creating a duplicate.

```typescript
const results = await store
  .query()
  .from("Run", "r")
  .traverse("contains", "ce")
  .to("Task", "t")
  .traverse("has_operation", "he")
  .to("Operation", "op")
  .traverse("produces", "pe")
  .to("Artifact", "art")
  .whereNode("r", (r) => r.id.eq(runId))
  .whereNode("art", (a) => a.contentHash.eq(contentHash))
  .select((ctx) => ({ node: ctx.art }))
  .execute();
```

**Key points:**

- Same 4-hop traversal as provenance queries but filtered by
  `contentHash` instead of artifact ID.
- The `contentHash` index on ArtifactNode makes this an indexed lookup
  rather than a full scan.
- Returns the query result, which must be resolved to a live graph node
  via `store.nodes.Artifact.getById()` before creating edges.

## 10. Version chain lookup

Find the most recent artifact with a given name in the run (excluding a
just-created node). Used to create `supersedes` edges for version history.

```typescript
const results = await store
  .query()
  .from("Run", "r")
  .traverse("contains", "ce")
  .to("Task", "t")
  .traverse("has_operation", "he")
  .to("Operation", "op")
  .traverse("produces", "pe")
  .to("Artifact", "art")
  .whereNode("r", (r) => r.id.eq(runId))
  .whereNode("art", (a) => a.name.eq(name))
  .select((ctx) => ({ node: ctx.art }))
  .execute();

// Filter and sort in JS — result set is small (versions of one artifact)
const candidates = results.filter((r) => String(r.node.id) !== excludeId);
// ISO 8601 timestamps sort lexicographically
candidates.sort((a, b) =>
  String(b.node.createdAt).localeCompare(String(a.node.createdAt)),
);
```

**Key points:**

- Same traversal shape as dedup, filtered by `name` instead of
  `contentHash`. Both queries run inside `createAndLinkProduced` when
  `runId` is provided.
- JS-side filtering excludes the just-created artifact to avoid
  self-referencing `supersedes` edges.
- Sorting by `createdAt` descending picks the latest previous version.
  The result set is bounded by the number of times the same logical
  artifact was written in one run — typically small.
