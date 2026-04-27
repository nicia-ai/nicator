import { HarnessError } from "../errors.js";
import {
  asDefinitionNodeId,
  asSkillNodeId,
  storageOp,
  toAgentDefinition,
  toArtifact,
  toSkill,
  toSkillRef,
} from "../repository-helpers.js";
import type {
  AgentDefinition,
  Artifact,
  Skill,
  SkillReference,
} from "../schema.js";
import { pickDefined } from "../utility.js";
import type { NicatorStore } from "./types.js";

export function createAgentRepo(store: NicatorStore) {
  /** Reconstruct SkillReference[] from uses edges for a definition. */
  async function getSkillReferencesForDefinition(
    definitionId: string,
  ): Promise<SkillReference[]> {
    const results = await store
      .query()
      .from("AgentDefinition", "d")
      .traverse("uses", "e")
      .to("Skill", "s")
      .whereNode("d", (d) => d.id.eq(definitionId))
      .select((ctx) => ({
        name: ctx.s.name,
        version: ctx.s.version,
        policy: ctx.e.policy,
      }))
      .execute();

    return results.map((row) => toSkillRef(row));
  }

  return {
    async getDefinition(
      id: string,
      version?: number,
    ): Promise<AgentDefinition | undefined> {
      return storageOp("agents.getDefinition", async () => {
        const node = await store.nodes.AgentDefinition.getById(
          asDefinitionNodeId(id),
        );
        if (!node) return undefined;
        if (version !== undefined && node.version !== version) return undefined;

        const skills = await getSkillReferencesForDefinition(id);
        return toAgentDefinition(node, skills);
      });
    },

    async createDefinition(definition: AgentDefinition): Promise<void> {
      return storageOp("agents.createDefinition", async () => {
        // Batch-fetch all skills in one query, validate and index
        const skillIndex = new Map<string, string>();
        if (definition.skills.length > 0) {
          const allSkills = await store
            .query()
            .from("Skill", "s")
            .select((ctx) => ({
              id: ctx.s.id,
              name: ctx.s.name,
              version: ctx.s.version,
            }))
            .execute();

          for (const s of allSkills) {
            skillIndex.set(
              `${String(s.name)}@${String(s.version)}`,
              String(s.id),
            );
          }

          for (const ref of definition.skills) {
            const key = `${ref.name}@${ref.version}`;
            if (!skillIndex.has(key)) {
              throw new HarnessError(
                `Skill "${key}" not found. Skills must be seeded before creating definitions.`,
                "skill_not_found",
              );
            }
          }
        }

        const defNode = await store.nodes.AgentDefinition.create(
          {
            version: definition.version,
            name: definition.name,
            description: definition.description,
            systemPrompt: definition.systemPrompt,
            limits: definition.limits,
            ...pickDefined({
              autoFinalizeFromSubagent: definition.autoFinalizeFromSubagent,
              workspace: definition.workspace,
            }),
            createdAt: definition.createdAt,
          },
          { id: definition.id },
        );

        for (const ref of definition.skills) {
          const nodeId = skillIndex.get(`${ref.name}@${ref.version}`);
          if (!nodeId) continue;

          const skillNode = await store.nodes.Skill.getById(
            asSkillNodeId(nodeId),
          );
          if (skillNode) {
            await store.edges.uses.create(
              defNode,
              skillNode,
              pickDefined({ policy: ref.policy }),
            );
          }
        }
      });
    },

    async listDefinitions(): Promise<AgentDefinition[]> {
      return storageOp("agents.listDefinitions", async () => {
        const nodes = await store
          .query()
          .from("AgentDefinition", "d")
          .orderBy("d", "createdAt", "desc")
          .select((ctx) => ctx.d)
          .execute();

        return Promise.all(
          nodes.map(async (node) => {
            const skills = await getSkillReferencesForDefinition(
              String(node.id),
            );
            return toAgentDefinition(node, skills);
          }),
        );
      });
    },

    /**
     * Register a skill node. Idempotent — returns existing ID if name+version
     * already exists. Backfills description/tools/maxIterations if the existing
     * node has empty values (handles placeholder nodes created by createDefinition).
     */
    async registerSkill(skill: Skill): Promise<string> {
      return storageOp("agents.registerSkill", async () => {
        const existing = await store
          .query()
          .from("Skill", "s")
          .whereNode("s", (s) => s.name.eq(skill.name))
          .select((ctx) => ({
            id: ctx.s.id,
            version: ctx.s.version,
            description: ctx.s.description,
            allowDirectTools: ctx.s.allowDirectTools,
            allowReadArtifact: ctx.s.allowReadArtifact,
            maxIterations: ctx.s.maxIterations,
          }))
          .execute();

        const match = existing.find((s) => s.version === skill.version);
        if (match) {
          const nodeId = String(match.id);
          // Backfill metadata from placeholder or stale nodes.
          const needsUpdate =
            (match.description === "" && skill.description !== "") ||
            match.allowDirectTools !== skill.allowDirectTools ||
            match.allowReadArtifact !== skill.allowReadArtifact ||
            match.maxIterations !== skill.maxIterations;

          if (needsUpdate) {
            await store.nodes.Skill.update(asSkillNodeId(nodeId), {
              description: skill.description,
              allowDirectTools: skill.allowDirectTools,
              allowReadArtifact: skill.allowReadArtifact,
              ...pickDefined({ maxIterations: skill.maxIterations }),
            });
          }
          return nodeId;
        }

        const node = await store.nodes.Skill.create({
          name: skill.name,
          version: skill.version,
          description: skill.description,
          allowDirectTools: skill.allowDirectTools,
          allowReadArtifact: skill.allowReadArtifact,
          ...pickDefined({ maxIterations: skill.maxIterations }),
        });
        return String(node.id);
      });
    },

    /**
     * Register a skill with its prompt artifact. Creates the Skill node,
     * a skill_prompt Artifact, and the has_definition edge. Idempotent.
     */
    async registerSkillWithPrompt(
      skill: Skill,
      promptArtifact: Artifact,
    ): Promise<string> {
      return storageOp("agents.registerSkillWithPrompt", async () => {
        const skillNodeId = await this.registerSkill(skill);

        // Check if definition artifact already linked
        const defResults = await store
          .query()
          .from("Skill", "s")
          .traverse("has_definition", "e")
          .to("Artifact", "a")
          .whereNode("s", (s) => s.id.eq(skillNodeId))
          .select((ctx) => ({ id: ctx.a.id }))
          .execute();

        if (defResults.length > 0) return skillNodeId;

        const artNode = await store.nodes.Artifact.create(
          {
            type: promptArtifact.type,
            name: promptArtifact.name,
            content: promptArtifact.content,
            contentHash: promptArtifact.contentHash,
            mimeType: promptArtifact.mimeType,
            createdAt: promptArtifact.createdAt,
          },
          { id: promptArtifact.id },
        );

        const skillNode = await store.nodes.Skill.getById(
          asSkillNodeId(skillNodeId),
        );
        if (skillNode) {
          await store.edges.has_definition.create(skillNode, artNode);
        }

        return skillNodeId;
      });
    },

    async resolveSkill(
      name: string,
      version?: string,
    ): Promise<{ skill: Skill; prompt: string } | undefined> {
      return storageOp("agents.resolveSkill", async () => {
        const results = await store
          .query()
          .from("Skill", "s")
          .traverse("has_definition", "e")
          .to("Artifact", "a")
          .whereNode("s", (s) => s.name.eq(name))
          .select((ctx) => ({ skill: ctx.s, artifact: ctx.a }))
          .execute();

        const match =
          version ?
            results.find((r) => r.skill.version === version)
          : results.toSorted((a, b) =>
              String(b.skill.version).localeCompare(
                String(a.skill.version),
                undefined,
                { numeric: true },
              ),
            )[0];

        if (!match) return undefined;

        return {
          skill: toSkill(match.skill),
          prompt: toArtifact(match.artifact).content,
        };
      });
    },

    async listSkills(): Promise<Skill[]> {
      return storageOp("agents.listSkills", async () => {
        const results = await store
          .query()
          .from("Skill", "s")
          .select((ctx) => ctx.s)
          .execute();
        return results.map((node) => toSkill(node));
      });
    },

    async listSkillsWithPrompts(): Promise<
      ReadonlyArray<{ skill: Skill; prompt: string }>
    > {
      return storageOp("agents.listSkillsWithPrompts", async () => {
        const results = await store
          .query()
          .from("Skill", "s")
          .traverse("has_definition", "e")
          .to("Artifact", "a")
          .select((ctx) => ({ skill: ctx.s, artifact: ctx.a }))
          .execute();

        return results.map((row) => ({
          skill: toSkill(row.skill),
          prompt: toArtifact(row.artifact).content,
        }));
      });
    },
  };
}
