import type { Tool } from "@nicator/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebSearchTool } from "./tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_TOOL: Tool = {
  name: "web-search",
  version: "1.0.0",
  description: "test stub",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", properties: {}, required: [] },
};

const BRAVE_KEY = "test-brave-api-key";

type SearchOutput = {
  results: ReadonlyArray<{ title: string; url: string; snippet: string }>;
  mock?: boolean;
};

function braveJsonResponse(
  results: Array<{ title: string; url: string; description: string }>,
) {
  return Response.json(
    { web: { results } },
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web-search tool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Mock mode (no API key)
  // -----------------------------------------------------------------------
  describe("mock mode (no BRAVE_API_KEY)", () => {
    it("returns mock results when API key is undefined", async () => {
      const tool = createWebSearchTool(STUB_TOOL, undefined);
      const result = (await tool.execute({
        query: "test query",
      })) as SearchOutput;

      expect(result.mock).toBe(true);
      expect(result.results).toHaveLength(2);
      const first = result.results[0];
      if (!first) throw new Error("expected first result");
      expect(first.title).toContain("test query");
      expect(first.url).toContain("example.com");
      expect(first.snippet).toContain("test query");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("returns mock results with empty string API key", async () => {
      const tool = createWebSearchTool(STUB_TOOL, "");
      const result = (await tool.execute({
        query: "anything",
      })) as SearchOutput;

      expect(result.mock).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Live mode (with API key)
  // -----------------------------------------------------------------------
  describe("live mode (with BRAVE_API_KEY)", () => {
    it("calls Brave API and returns formatted results", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        braveJsonResponse([
          {
            title: "Result One",
            url: "https://one.com",
            description: "First result",
          },
          {
            title: "Result Two",
            url: "https://two.com",
            description: "Second result",
          },
        ]),
      );

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      const result = (await tool.execute({
        query: "typescript testing",
      })) as SearchOutput;

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        title: "Result One",
        url: "https://one.com",
        snippet: "First result",
      });
      expect(result.results[1]).toEqual({
        title: "Result Two",
        url: "https://two.com",
        snippet: "Second result",
      });
    });

    it("sends correct headers and query params", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(braveJsonResponse([]));

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      await tool.execute({ query: "hello world", maxResults: 3 });

      expect(fetch).toHaveBeenCalledOnce();
      const call = vi.mocked(fetch).mock.calls[0];
      if (!call) throw new Error("expected fetch call");
      const [url, init] = call;

      const parsed = new URL(url as string);
      expect(parsed.searchParams.get("q")).toBe("hello world");
      expect(parsed.searchParams.get("count")).toBe("3");

      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["X-Subscription-Token"]).toBe(BRAVE_KEY);
      expect(headers["Accept"]).toBe("application/json");
    });

    it("defaults maxResults to 5", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(braveJsonResponse([]));

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      await tool.execute({ query: "default count" });

      const call = vi.mocked(fetch).mock.calls[0];
      if (!call) throw new Error("expected fetch call");
      const parsed = new URL(call[0] as string);
      expect(parsed.searchParams.get("count")).toBe("5");
    });

    it("caps maxResults at 10", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(braveJsonResponse([]));

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      await tool.execute({ query: "capped", maxResults: 50 });

      const call = vi.mocked(fetch).mock.calls[0];
      if (!call) throw new Error("expected fetch call");
      const parsed = new URL(call[0] as string);
      expect(parsed.searchParams.get("count")).toBe("10");
    });

    it("slices results to the requested count", async () => {
      const manyResults = Array.from({ length: 8 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        description: `Description ${index}`,
      }));
      vi.mocked(fetch).mockResolvedValueOnce(braveJsonResponse(manyResults));

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      const result = (await tool.execute({
        query: "many",
        maxResults: 3,
      })) as SearchOutput;

      expect(result.results).toHaveLength(3);
    });

    it("handles empty web results gracefully", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json(
          { web: { results: [] } },
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      const result = (await tool.execute({ query: "obscure" })) as SearchOutput;

      expect(result.results).toHaveLength(0);
    });

    it("handles missing web field in response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json(
          {},
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);
      const result = (await tool.execute({ query: "no web" })) as SearchOutput;

      expect(result.results).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    it("returns error object on non-ok API response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
      );

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(
        tool.execute({ query: "rate limit" }),
      ).resolves.toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.stringMatching(/429/),
        query: "rate limit",
      });
    });

    it("throws on network error", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(tool.execute({ query: "offline" })).rejects.toThrow(
        /fetch failed/,
      );
    });

    it("throws on malformed JSON response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("not json {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(tool.execute({ query: "bad json" })).rejects.toThrow();
    });

    it("throws on missing query", async () => {
      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(tool.execute({})).rejects.toThrow();
    });

    it("throws on invalid maxResults type", async () => {
      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(
        tool.execute({ query: "ok", maxResults: "not a number" }),
      ).rejects.toThrow();
    });

    it("rejects maxResults of zero", async () => {
      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(
        tool.execute({ query: "ok", maxResults: 0 }),
      ).rejects.toThrow();
    });

    it("rejects negative maxResults", async () => {
      const tool = createWebSearchTool(STUB_TOOL, BRAVE_KEY);

      await expect(
        tool.execute({ query: "ok", maxResults: -1 }),
      ).rejects.toThrow();
    });
  });
});
