import type { Tool } from "@nicator/core";
import type { ToolImplementation } from "@nicator/harness";
import { z } from "zod";

const WebSearchInputSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().positive().optional(),
});

const BraveSearchResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string(),
            url: z.string(),
            description: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});

type SearchResult = Readonly<{
  title: string;
  url: string;
  snippet: string;
}>;

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export function createWebSearchTool(
  tool: Tool,
  braveApiKey: string | undefined,
): ToolImplementation {
  return {
    tool: tool,
    async execute(input: unknown): Promise<unknown> {
      const { query, maxResults = 5 } = WebSearchInputSchema.parse(input);
      const count = Math.min(maxResults, 10);

      if (!braveApiKey) {
        return mockResponse(query);
      }

      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const resp = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": braveApiKey,
        },
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return {
          error: `Search API returned ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
          query,
        };
      }

      const data = BraveSearchResponseSchema.parse(await resp.json());
      const webResults = data.web?.results ?? [];

      const results: SearchResult[] = webResults.slice(0, count).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
      }));

      return { results };
    },
  };
}

function mockResponse(query: string): {
  results: ReadonlyArray<SearchResult>;
  mock: boolean;
} {
  return {
    results: [
      {
        title: `Mock result 1 for: ${query}`,
        url: "https://example.com/result-1",
        snippet: `This is a mock search result for the query "${query}". Set BRAVE_API_KEY for real results.`,
      },
      {
        title: `Mock result 2 for: ${query}`,
        url: "https://example.com/result-2",
        snippet: `Another mock result for "${query}". Real search results require a Brave Search API key.`,
      },
    ],
    mock: true,
  };
}
