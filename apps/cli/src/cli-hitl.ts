import { createInterface } from "node:readline";

import type { HitlContext, HitlHandler } from "@nicator/core";
import { CLI_HITL_TIMEOUT_MS } from "@nicator/core";

export class CliHitlHandler implements HitlHandler {
  constructor(private readonly timeoutMs: number = CLI_HITL_TIMEOUT_MS) {}

  async requestApproval(context: HitlContext, prompt: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const timeoutSeconds = Math.round(this.timeoutMs / 1000);
    let timer: ReturnType<typeof setTimeout> | undefined;

    return Promise.race([
      new Promise<string>((resolve) => {
        console.log("\n========================================");
        console.log("HUMAN APPROVAL REQUIRED");
        console.log("========================================");
        console.log(`Task:    ${context.taskId}`);
        if (context.subagentName !== undefined) {
          console.log(`Skill:   ${context.subagentName}`);
        }
        console.log(`Prompt:  ${prompt}`);
        console.log(`Timeout: ${timeoutSeconds}s`);
        console.log("----------------------------------------");

        rl.question("Your response (approve/deny + note): ", (answer) => {
          clearTimeout(timer);
          rl.close();
          resolve(answer || "no response");
        });
      }),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          rl.close();
          console.log("\n[HITL] Timed out waiting for response.");
          resolve("timeout");
        }, this.timeoutMs);
      }),
    ]);
  }
}
