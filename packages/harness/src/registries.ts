import type { ToolImplementation, ToolRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// Map-based registry constructors
// ---------------------------------------------------------------------------

/** Build a ToolRegistry from a map of name → implementation. */
export function toolRegistryFromMap(
  entries: ReadonlyArray<readonly [string, ToolImplementation]>,
): ToolRegistry {
  const registry = new Map(entries);
  return {
    resolve(name: string) {
      return registry.get(name);
    },
    list(): ReadonlyArray<ToolImplementation> {
      return [...registry.values()];
    },
    listTools(names: ReadonlyArray<string>): ReadonlyArray<ToolImplementation> {
      const result: ToolImplementation[] = [];
      for (const name of names) {
        const impl = registry.get(name);
        if (impl) result.push(impl);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Empty registries
// ---------------------------------------------------------------------------

export function createEmptyToolRegistry(): ToolRegistry {
  return { resolve: () => undefined, list: () => [], listTools: () => [] };
}
