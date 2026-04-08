export type Env = {
  DB: D1Database;
  HITL_DO: DurableObjectNamespace;
  RUN_EXECUTION_DO: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  BRAVE_API_KEY?: string;
  ALLOWED_DEFINITION_IDS?: string;
};
