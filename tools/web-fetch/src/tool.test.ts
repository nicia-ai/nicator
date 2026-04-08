import type { Tool } from "@nicator/core";
import { CHARS_PER_TOKEN_PROSE, estimateTokens } from "@nicator/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdf-parse", () => {
  const getText = vi.fn().mockResolvedValue({
    text: "Extracted PDF content\nPage 1 of 1",
    pages: [],
    total: 1,
  });

  return {
    PDFParse: class {
      getText = getText;
    },
  };
});

import {
  createWebFetchTool,
  detectContentType,
  htmlToMarkdown,
  truncate,
} from "./tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_TOOL: Tool = {
  name: "web-fetch",
  version: "1.0.0",
  description: "test stub",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", properties: {}, required: [] },
};

const MAX_TOKENS = 8000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN_PROSE;

/** Native Response with a custom `url` property (read-only on real Response). */
function responseWithUrl(
  url: string,
  body: BodyInit,
  init?: ResponseInit,
): Response {
  const resp = new Response(body, init);
  Object.defineProperty(resp, "url", { value: url });
  return resp;
}

type FetchResult = Promise<{
  content: string;
  url: string;
  tokenCount: number;
  truncated: boolean;
}>;

function execute(url: string): FetchResult {
  const tool = createWebFetchTool(STUB_TOOL);
  return tool.execute({ url }) as FetchResult;
}

// ---------------------------------------------------------------------------
// Pure function tests — no mocks
// ---------------------------------------------------------------------------

describe("detectContentType", () => {
  it("returns 'html' for null header (Headers.get() returns null)", () => {
    // eslint-disable-next-line unicorn/no-null -- Headers.get() returns null per Web API spec
    expect(detectContentType(null)).toBe("html");
  });

  it("returns 'html' for text/html", () => {
    expect(detectContentType("text/html; charset=utf-8")).toBe("html");
  });

  it("returns 'pdf' for application/pdf", () => {
    expect(detectContentType("application/pdf")).toBe("pdf");
  });

  it("returns 'text' for text/plain", () => {
    expect(detectContentType("text/plain")).toBe("text");
  });

  it("returns 'text' for text/markdown", () => {
    expect(detectContentType("text/markdown; charset=utf-8")).toBe("text");
  });

  it("returns 'html' for application/json (no dedicated handler)", () => {
    expect(detectContentType("application/json")).toBe("html");
  });

  it("returns 'html' for application/xhtml+xml", () => {
    expect(detectContentType("application/xhtml+xml")).toBe("html");
  });

  it("is case-insensitive", () => {
    expect(detectContentType("Application/PDF")).toBe("pdf");
    expect(detectContentType("TEXT/PLAIN")).toBe("text");
  });
});

describe("htmlToMarkdown", () => {
  it("converts a simple article to markdown with heading", () => {
    const html = `<!DOCTYPE html>
<html><head><title>Test Article</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Test Article</h1>
    <p>First paragraph with a <a href="https://example.com">link</a>.</p>
    <p>Second paragraph.</p>
    <h2>Subheading</h2>
    <ul>
      <li>Item one</li>
      <li>Item two</li>
    </ul>
  </article>
  <footer>Copyright 2026</footer>
</body></html>`;

    const md = htmlToMarkdown(html);

    expect(md).toContain("# Test Article");
    expect(md).toContain("[link](https://example.com)");
    expect(md).toMatch(/-\s+Item one/);
    expect(md).toMatch(/-\s+Item two/);
    expect(md).toContain("## Subheading");
    expect(md).not.toContain("Copyright 2026");
  });

  it("preserves fenced code blocks", () => {
    const html = `<html><body><article>
      <h1>Code Example</h1>
      <p>Here is some code:</p>
      <pre><code class="language-js">const x = 42;
console.log(x);</code></pre>
      <p>And inline <code>foo()</code> too.</p>
    </article></body></html>`;

    const md = htmlToMarkdown(html);

    expect(md).toContain("```");
    expect(md).toContain("const x = 42;");
    expect(md).toContain("`foo()`");
  });

  it("converts tables to GFM markdown", () => {
    const html = `<html><body><article>
      <h1>Data Table</h1>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Alpha</td><td>1</td></tr>
          <tr><td>Beta</td><td>2</td></tr>
        </tbody>
      </table>
    </article></body></html>`;

    const md = htmlToMarkdown(html);

    expect(md).toContain("Name");
    expect(md).toContain("Value");
    expect(md).toContain("|");
    expect(md).toContain("---");
  });

  it("strips script and style tags", () => {
    const html = `<html><body>
      <script>alert("xss")</script>
      <style>.hidden { display: none; }</style>
      <article>
        <h1>Clean Page</h1>
        <p>Just the content.</p>
      </article>
    </body></html>`;

    const md = htmlToMarkdown(html);

    expect(md).not.toContain("alert");
    expect(md).not.toContain("display: none");
    expect(md).toContain("Just the content.");
  });

  it("falls back to full body when readability cannot extract an article", () => {
    const html = `<html><body><p>Short snippet</p></body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("Short snippet");
  });

  it("crashes on non-HTML input (JSON string)", () => {
    const json = JSON.stringify({ key: "value" });
    // BUG: parseHTML on non-HTML produces an invalid document for Readability
    expect(() => htmlToMarkdown(json)).toThrow(/Readability/);
  });
});

describe("truncate", () => {
  it("returns content unchanged when under the limit", () => {
    const result = truncate("Short.");
    expect(result).toEqual({ content: "Short.", truncated: false });
  });

  it("returns content unchanged when exactly at the limit", () => {
    const exact = "y".repeat(MAX_CHARS);
    const result = truncate(exact);
    expect(result).toEqual({ content: exact, truncated: false });
  });

  it("truncates content exceeding the limit and appends marker", () => {
    const long = "x".repeat(MAX_CHARS + 1000);
    const result = truncate(long);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[Content truncated at");
    const markerIndex = result.content.indexOf("\n\n[Content truncated");
    expect(markerIndex).toBe(MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — mock fetch at the I/O boundary
// ---------------------------------------------------------------------------

describe("web-fetch execute", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("content-type routing", () => {
    it("converts HTML response to markdown", async () => {
      const html = `<html><body><article><h1>Hello</h1><p>World</p></article></body></html>`;
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(html, { headers: { "content-type": "text/html" } }),
      );

      const result = await execute("https://example.com");

      expect(result.content).toContain("# Hello");
      expect(result.content).toContain("World");
    });

    it("passes through text/plain without conversion", async () => {
      const text = "This is plain text.\nNo HTML here.";
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(text, { headers: { "content-type": "text/plain" } }),
      );

      const result = await execute("https://example.com/plain.txt");

      expect(result.content).toBe(text);
    });

    it("passes through text/markdown without conversion", async () => {
      const md = "# Hello\n\nThis is *markdown*.";
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(md, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
      );

      const result = await execute("https://example.com/doc.md");

      expect(result.content).toBe(md);
    });

    it("defaults to HTML conversion when content-type is missing", async () => {
      const html = `<html><body><article><h1>No CT</h1><p>Works.</p></article></body></html>`;
      vi.mocked(fetch).mockResolvedValueOnce(new Response(html));

      const result = await execute("https://example.com/no-ct");

      expect(result.content).toContain("Works.");
    });
  });

  describe("PDF extraction", () => {
    it("extracts text via pdf-parse", async () => {
      const buf = new ArrayBuffer(100);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(buf, { headers: { "content-type": "application/pdf" } }),
      );

      const result = await execute("https://example.com/doc.pdf");

      expect(result.content).toContain("Extracted PDF content");
    });

    it("returns error for PDFs exceeding the size limit", async () => {
      const bigBuf = new ArrayBuffer(11 * 1024 * 1024);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(bigBuf, {
          headers: { "content-type": "application/pdf" },
        }),
      );

      await expect(
        execute("https://example.com/huge.pdf"),
      ).resolves.toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.stringMatching(/PDF too large/),
        url: "https://example.com/huge.pdf",
      });
    });
  });

  describe("token counting", () => {
    it("estimates tokens using content-aware estimateTokens", async () => {
      const text = "a".repeat(17); // prose: 17 / 4 = 4.25 -> 5
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(text, { headers: { "content-type": "text/plain" } }),
      );

      const result = await execute("https://example.com/count.txt");

      expect(result.tokenCount).toBe(estimateTokens(text));
    });
  });

  describe("request behavior", () => {
    it("sends Accept header preferring markdown", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("<html><body><p>hi</p></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      );

      await execute("https://example.com");

      const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(calledUrl).toBe("https://example.com");
      const headers = calledInit?.headers as Record<string, string> | undefined;
      expect(headers?.["Accept"]).toContain("text/markdown");
    });

    it("returns the final URL after redirects", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        responseWithUrl(
          "https://example.com/final",
          "<html><body>redirected</body></html>",
          { headers: { "content-type": "text/html" } },
        ),
      );

      const result = await execute("https://example.com/redirect");

      expect(result.url).toBe("https://example.com/final");
    });
  });

  describe("error handling", () => {
    it("returns error object on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
      );

      await expect(
        execute("https://example.com/missing"),
      ).resolves.toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.stringMatching(/Fetch failed.*404/),
        status: 404,
        url: "https://example.com/missing",
      });
    });

    it("propagates network errors", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(execute("https://example.com/down")).rejects.toThrow(
        /fetch failed/,
      );
    });

    it("propagates DNS resolution failures", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(
        new TypeError("getaddrinfo ENOTFOUND no-such-host.invalid"),
      );

      await expect(execute("https://no-such-host.invalid")).rejects.toThrow(
        /ENOTFOUND/,
      );
    });

    it("throws on invalid URL input", async () => {
      const tool = createWebFetchTool(STUB_TOOL);
      await expect(tool.execute({ url: "not-a-url" })).rejects.toThrow();
    });

    it("throws on missing URL input", async () => {
      const tool = createWebFetchTool(STUB_TOOL);
      await expect(tool.execute({})).rejects.toThrow();
    });
  });
});
