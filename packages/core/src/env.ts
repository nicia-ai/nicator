import { z } from "zod";

// Minimal declaration — avoids depending on @types/node in core,
// which must remain runtime-agnostic (Node + Cloudflare Workers).
declare const process: { env: Record<string, string | undefined> };

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  BRAVE_API_KEY: z.string().optional(),
});

const env = EnvSchema.parse(process.env);

export default env;
