import "./vendor.d.ts";

import { Readability } from "@mozilla/readability";
import type { Tool } from "@nicator/core";
import { CHARS_PER_TOKEN_PROSE, estimateTokens } from "@nicator/core";
import type { ToolImplementation } from "@nicator/harness";
import { parseHTML } from "linkedom";
import { PDFParse } from "pdf-parse";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";

const MAX_TOKENS = 8000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN_PROSE;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB fetch limit

const WebFetchInputSchema = z.object({
  url: z.url(),
});

type ContentType = "html" | "pdf" | "text";

export function detectContentType(header: string | null): ContentType {
  if (!header) return "html";
  const ct = header.toLowerCase();
  if (ct.includes("application/pdf")) return "pdf";
  if (ct.includes("text/plain") || ct.includes("text/markdown")) return "text";
  return "html";
}

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);

  // Remove script, style, nav, footer, and other non-content elements
  td.remove([
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "aside",
    "noscript",
  ]);

  return td;
}

export function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(html);

  // Try readability extraction first — falls back to full-page conversion
  const reader = new Readability(document.cloneNode(true) as Document, {
    charThreshold: 100,
  });
  const article = reader.parse();

  const td = createTurndown();

  if (article?.content) {
    const titlePrefix = article.title ? `# ${article.title}\n\n` : "";
    return titlePrefix + td.turndown(article.content);
  }

  // Readability failed (non-article pages, etc.) — convert full body
  const body = document.querySelector("body");
  if (!body) return td.turndown(html);
  return td.turndown(body.innerHTML);
}

async function pdfToText(buffer: ArrayBuffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}

export function truncate(content: string): {
  content: string;
  truncated: boolean;
} {
  if (content.length <= MAX_CHARS) {
    return { content, truncated: false };
  }
  return {
    content:
      content.slice(0, MAX_CHARS) +
      `\n\n[Content truncated at ${MAX_TOKENS.toLocaleString()} tokens]`,
    truncated: true,
  };
}

export function createWebFetchTool(tool: Tool): ToolImplementation {
  return {
    tool,
    async execute(input: unknown): Promise<unknown> {
      const { url } = WebFetchInputSchema.parse(input);

      const resp = await fetch(url, {
        headers: {
          "User-Agent": "AgentHarness/1.0 (web-fetch tool)",
          Accept:
            "text/markdown, text/html, application/xhtml+xml, application/pdf, text/plain, */*",
        },
        redirect: "follow",
      });

      if (!resp.ok) {
        // Consume body to release connection resources
        await resp.body?.cancel?.();
        return {
          error: `Fetch failed for ${url}: ${resp.status} ${resp.statusText}`,
          status: resp.status,
          url,
        };
      }

      const contentType = detectContentType(resp.headers.get("content-type"));

      let content: string;

      switch (contentType) {
        case "pdf": {
          const buf = await resp.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) {
            return {
              error: `PDF too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB, limit ${MAX_BYTES / 1024 / 1024} MB)`,
              url,
            };
          }
          content = await pdfToText(buf);
          break;
        }
        case "text": {
          content = await resp.text();
          break;
        }
        case "html": {
          const html = await resp.text();
          content = htmlToMarkdown(html);
          break;
        }
      }

      const { content: finalContent, truncated } = truncate(content);
      const tokenCount = estimateTokens(finalContent);

      return {
        content: finalContent,
        url: resp.url,
        tokenCount,
        truncated,
      };
    },
  };
}
