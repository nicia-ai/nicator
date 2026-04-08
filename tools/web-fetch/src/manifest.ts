import { ToolSchema } from "@nicator/core";

import json from "../tool.json" with { type: "json" };

export const webFetchManifest = ToolSchema.parse(json);
