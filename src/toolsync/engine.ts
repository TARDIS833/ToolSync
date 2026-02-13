import * as path from "node:path";
import { ITEM_TYPES, type Registry, type Snapshot, type ToolPlan, type ToolSyncConfig } from "./types";
import { listJson, readJson, writeJson } from "./fs";

function uniq(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function normalizeSnapshot(tool: string, raw: Partial<Snapshot> | null): Snapshot {
  return {
    tool,
    updatedAt: raw?.updatedAt ?? new Date(0).toISOString(),
    extension: uniq(raw?.extension ?? []),
    mcp: uniq(raw?.mcp ?? []),
    skill: uniq(raw?.skill ?? []),
    terminal_theme: uniq(raw?.terminal_theme ?? []),
    editor_theme: uniq(raw?.editor_theme ?? []),
    env: raw?.env ?? {}
  };
}

function pickLatestEnv(snapshots: Snapshot[], key: string): { value: string; sourceTool: string; updatedAt: string } | null {
  const candidates = snapshots
    .filter((s) => Object.prototype.hasOwnProperty.call(s.env, key))
    .map((s) => ({ value: s.env[key], sourceTool: String(s.tool), updatedAt: s.updatedAt }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

export function readAllSnapshots(syncRoot: string, tools: string[]): Snapshot[] {
  const snapshotsDir = path.join(syncRoot, "snapshots");
  const snapshots: Snapshot[] = [];

  for (const tool of tools) {
    const filePath = path.join(snapshotsDir, `${tool}.json`);
    const raw = readJson<Partial<Snapshot> | null>(filePath, null);
    if (raw) {
      snapshots.push(normalizeSnapshot(tool, raw));
    }
  }

  for (const filePath of listJson(snapshotsDir)) {
    const tool = path.basename(filePath, ".json");
    if (tools.includes(tool)) {
      continue;
    }
    const raw = readJson<Partial<Snapshot> | null>(filePath, null);
    if (raw) {
      snapshots.push(normalizeSnapshot(tool, raw));
    }
  }

  return snapshots;
}

export function buildRegistry(revision: number, config: ToolSyncConfig, snapshots: Snapshot[]): Registry {
  const byType: Registry["byType"] = {
    extension: {},
    mcp: {},
    skill: {},
    terminal_theme: {},
    editor_theme: {}
  };

  for (const snap of snapshots) {
    for (const type of ITEM_TYPES) {
      for (const name of snap[type]) {
        byType[type][name] = byType[type][name] ?? {};
        byType[type][name][String(snap.tool)] = true;
      }
    }
  }

  const env: Registry["env"] = {};
  for (const key of config.allowEnvKeys) {
    const latest = pickLatestEnv(snapshots, key);
    if (latest) {
      env[key] = latest;
    }
  }

  return {
    revision,
    updatedAt: new Date().toISOString(),
    tools: config.tools,
    byType,
    env
  };
}

export function buildPlans(registry: Registry, snapshots: Snapshot[]): Record<string, ToolPlan> {
  const byTool = new Map(snapshots.map((s) => [String(s.tool), s]));
  const plans: Record<string, ToolPlan> = {};

  for (const tool of registry.tools) {
    const toolName = String(tool);
    const local = byTool.get(toolName) ?? normalizeSnapshot(toolName, null);
    const actions: ToolPlan["actions"] = [];

    for (const type of ITEM_TYPES) {
      for (const [name, installedMap] of Object.entries(registry.byType[type])) {
        if (!installedMap[toolName]) {
          actions.push({
            action: "install",
            type,
            name,
            sourceTools: Object.keys(installedMap)
          });
        }
      }
    }

    for (const [key, payload] of Object.entries(registry.env)) {
      if (local.env[key] !== payload.value) {
        actions.push({
          action: "set_env",
          type: "env",
          key,
          value: payload.value,
          sourceTool: payload.sourceTool
        });
      }
    }

    plans[toolName] = {
      tool: toolName,
      revision: registry.revision,
      generatedAt: new Date().toISOString(),
      actionCount: actions.length,
      actions
    };
  }

  return plans;
}

export function writeRegistryAndPlans(syncRoot: string, registry: Registry, plans: Record<string, ToolPlan>): void {
  writeJson(path.join(syncRoot, "registry.json"), registry);

  for (const [tool, plan] of Object.entries(plans)) {
    writeJson(path.join(syncRoot, "plans", `${tool}.json`), plan);
  }
}
