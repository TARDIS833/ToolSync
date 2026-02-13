export const SUPPORTED_TOOLS = [
  "vscode",
  "cursor",
  "codex",
  "antigravity",
  "claude",
  "lmstudio"
] as const;

export type ToolId = (typeof SUPPORTED_TOOLS)[number] | string;

export const ITEM_TYPES = [
  "extension",
  "mcp",
  "skill",
  "terminal_theme",
  "editor_theme"
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export type Snapshot = {
  tool: ToolId;
  updatedAt: string;
  extension: string[];
  mcp: string[];
  skill: string[];
  terminal_theme: string[];
  editor_theme: string[];
  env: Record<string, string>;
};

export type ToolSyncConfig = {
  tools: ToolId[];
  allowEnvKeys: string[];
  propagateDelete: boolean;
  excludeExtensions: string[];
  excludeMcp: string[];
  excludeSkills: string[];
  applyRetryCount: number;
  applyRetryDelaySec: number;
  logMaxSizeKb: number;
  logKeepArchives: number;
  reportTailLines: number;
};

export type Registry = {
  revision: number;
  updatedAt: string;
  tools: ToolId[];
  byType: Record<ItemType, Record<string, Record<string, true>>>;
  env: Record<string, { value: string; sourceTool: string; updatedAt: string }>;
};

export type PlanAction =
  | {
      action: "install";
      type: ItemType;
      name: string;
      sourceTools: string[];
    }
  | {
      action: "set_env";
      type: "env";
      key: string;
      value: string;
      sourceTool: string;
    };

export type ToolPlan = {
  tool: ToolId;
  revision: number;
  generatedAt: string;
  actionCount: number;
  actions: PlanAction[];
};
