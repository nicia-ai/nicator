import type { HitlContext, HitlHandler } from "@nicator/core";

export class AutoApproveHitlHandler implements HitlHandler {
  requestApproval(_context: HitlContext, _prompt: string): Promise<string> {
    return Promise.resolve("approved");
  }
}

export class DenyHitlHandler implements HitlHandler {
  requestApproval(_context: HitlContext, _prompt: string): Promise<string> {
    return Promise.resolve("rejected");
  }
}
