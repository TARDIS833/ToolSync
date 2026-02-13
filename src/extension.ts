import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildPlans, buildRegistry, readAllSnapshots, writeRegistryAndPlans } from "./toolsync/engine";
import { ensureDir, readJson, writeJson } from "./toolsync/fs";
import { SUPPORTED_TOOLS, type Snapshot, type ToolPlan, type ToolSyncConfig } from "./toolsync/types";

type ToolSyncPaths = {
  syncRoot: string;
  configPath: string;
  statePath: string;
  snapshotsDir: string;
  plansDir: string;
  registryPath: string;
};

function resolveHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getPaths(): ToolSyncPaths {
  const cfg = vscode.workspace.getConfiguration("toolsync");
  const syncRoot = resolveHomePath(cfg.get<string>("syncRoot", "~/ToolSync"));

  return {
    syncRoot,
    configPath: path.join(syncRoot, "config.json"),
    statePath: path.join(syncRoot, "state.json"),
    snapshotsDir: path.join(syncRoot, "snapshots"),
    plansDir: path.join(syncRoot, "plans"),
    registryPath: path.join(syncRoot, "registry.json")
  };
}

function getDefaultConfig(): ToolSyncConfig {
  const cfg = vscode.workspace.getConfiguration("toolsync");
  const tools = cfg.get<string[]>("tools", [...SUPPORTED_TOOLS]);
  const allowEnvKeys = cfg.get<string[]>("allowEnvKeys", ["LANG", "LC_ALL", "TERM", "TZ"]);
  const propagateDelete = cfg.get<boolean>("propagateDelete", false);

  return { tools, allowEnvKeys, propagateDelete };
}

function ensureBaseLayout(paths: ToolSyncPaths): void {
  ensureDir(paths.syncRoot);
  ensureDir(paths.snapshotsDir);
  ensureDir(paths.plansDir);

  if (!fs.existsSync(paths.configPath)) {
    writeJson(paths.configPath, getDefaultConfig());
  }

  if (!fs.existsSync(paths.statePath)) {
    writeJson(paths.statePath, { revision: 0, lastRunAt: null });
  }
}

function loadConfig(paths: ToolSyncPaths): ToolSyncConfig {
  const raw = readJson<Partial<ToolSyncConfig>>(paths.configPath, {});
  const defaults = getDefaultConfig();
  return {
    tools: Array.isArray(raw.tools) && raw.tools.length > 0 ? raw.tools : defaults.tools,
    allowEnvKeys:
      Array.isArray(raw.allowEnvKeys) && raw.allowEnvKeys.length > 0 ? raw.allowEnvKeys : defaults.allowEnvKeys,
    propagateDelete: typeof raw.propagateDelete === "boolean" ? raw.propagateDelete : defaults.propagateDelete
  };
}

async function snapshotVscode(paths: ToolSyncPaths, output: vscode.OutputChannel): Promise<Snapshot> {
  const config = loadConfig(paths);
  const settings = vscode.workspace.getConfiguration("toolsync");

  const extensionIds = vscode.extensions.all
    .map((ext) => ext.id)
    .filter((id) => id !== "tardis833.toolsync")
    .sort((a, b) => a.localeCompare(b));

  const editorTheme = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme", "Default Dark+");

  const terminalTheme = settings.get<string>("terminalTheme", "Default");
  const mcp = settings.get<string[]>("mcp", []);
  const skills = settings.get<string[]>("skills", []);

  const env: Record<string, string> = {};
  for (const key of config.allowEnvKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  const snap: Snapshot = {
    tool: "vscode",
    updatedAt: new Date().toISOString(),
    extension: extensionIds,
    mcp,
    skill: skills,
    terminal_theme: terminalTheme ? [terminalTheme] : [],
    editor_theme: editorTheme ? [editorTheme] : [],
    env
  };

  writeJson(path.join(paths.snapshotsDir, "vscode.json"), snap);
  output.appendLine(`[snapshot] vscode extensions=${snap.extension.length} mcp=${snap.mcp.length} skills=${snap.skill.length}`);
  return snap;
}

function buildAndPersistPlans(paths: ToolSyncPaths, output: vscode.OutputChannel): { revision: number; actionCount: number } {
  const config = loadConfig(paths);
  const state = readJson<{ revision: number }>(paths.statePath, { revision: 0 });
  const nextRevision = (state.revision ?? 0) + 1;
  const snapshots = readAllSnapshots(paths.syncRoot, config.tools.map(String));

  const registry = buildRegistry(nextRevision, config, snapshots);
  const plans = buildPlans(registry, snapshots);
  writeRegistryAndPlans(paths.syncRoot, registry, plans);

  const totalActions = Object.values(plans).reduce((acc, plan) => acc + plan.actionCount, 0);
  writeJson(paths.statePath, { revision: nextRevision, lastRunAt: new Date().toISOString() });

  output.appendLine(`[plan] revision=${nextRevision} snapshots=${snapshots.length} totalActions=${totalActions}`);
  return { revision: nextRevision, actionCount: totalActions };
}

async function installVscodeExtension(extensionId: string): Promise<void> {
  await vscode.commands.executeCommand("workbench.extensions.installExtension", extensionId);
}

async function applyVscodePlan(paths: ToolSyncPaths, output: vscode.OutputChannel): Promise<{ ok: number; fail: number }> {
  const planPath = path.join(paths.plansDir, "vscode.json");
  const plan = readJson<ToolPlan | null>(planPath, null);

  if (!plan) {
    return { ok: 0, fail: 0 };
  }

  let ok = 0;
  let fail = 0;

  for (const action of plan.actions) {
    try {
      if (action.action === "install") {
        if (action.type === "extension") {
          await installVscodeExtension(action.name);
          output.appendLine(`[apply] install extension ${action.name}`);
          ok += 1;
          continue;
        }

        if (action.type === "editor_theme") {
          await vscode.workspace.getConfiguration("workbench").update("colorTheme", action.name, vscode.ConfigurationTarget.Global);
          output.appendLine(`[apply] set editor theme ${action.name}`);
          ok += 1;
          continue;
        }

        if (action.type === "terminal_theme") {
          await vscode.workspace.getConfiguration("toolsync").update("terminalTheme", action.name, vscode.ConfigurationTarget.Global);
          output.appendLine(`[apply] set terminal theme marker ${action.name}`);
          ok += 1;
          continue;
        }

        if (action.type === "mcp") {
          const curr = vscode.workspace.getConfiguration("toolsync").get<string[]>("mcp", []);
          const next = Array.from(new Set([...curr, action.name]));
          await vscode.workspace.getConfiguration("toolsync").update("mcp", next, vscode.ConfigurationTarget.Global);
          output.appendLine(`[apply] add mcp ${action.name}`);
          ok += 1;
          continue;
        }

        if (action.type === "skill") {
          const curr = vscode.workspace.getConfiguration("toolsync").get<string[]>("skills", []);
          const next = Array.from(new Set([...curr, action.name]));
          await vscode.workspace.getConfiguration("toolsync").update("skills", next, vscode.ConfigurationTarget.Global);
          output.appendLine(`[apply] add skill ${action.name}`);
          ok += 1;
          continue;
        }
      }

      if (action.action === "set_env") {
        const envKey =
          process.platform === "darwin"
            ? "terminal.integrated.env.osx"
            : process.platform === "win32"
              ? "terminal.integrated.env.windows"
              : "terminal.integrated.env.linux";

        const current = vscode.workspace.getConfiguration().get<Record<string, string>>(envKey, {});
        const next = { ...current, [action.key]: action.value };
        await vscode.workspace.getConfiguration().update(envKey, next, vscode.ConfigurationTarget.Global);
        output.appendLine(`[apply] set env ${action.key}`);
        ok += 1;
        continue;
      }

      fail += 1;
      output.appendLine(`[apply] skipped unsupported action ${JSON.stringify(action)}`);
    } catch (error) {
      fail += 1;
      output.appendLine(`[apply] failed: ${JSON.stringify(action)} error=${String(error)}`);
    }
  }

  return { ok, fail };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ToolSync");

  const statusCmd = vscode.commands.registerCommand("toolsync.hello", async () => {
    const paths = getPaths();
    const message = [
      "ToolSync는 로컬 전용으로 동작합니다.",
      `syncRoot: ${paths.syncRoot}`,
      "Marketplace 자동 업데이트 없이 VSIX 설치 방식으로 운영됩니다."
    ].join("\n");
    await vscode.window.showInformationMessage(message, { modal: true });
  });

  const initCmd = vscode.commands.registerCommand("toolsync.init", async () => {
    const paths = getPaths();
    ensureBaseLayout(paths);
    const cfg = loadConfig(paths);
    writeJson(paths.configPath, cfg);
    output.appendLine(`[init] syncRoot=${paths.syncRoot}`);
    await vscode.window.showInformationMessage(`ToolSync 초기화 완료: ${paths.syncRoot}`);
  });

  const snapshotCmd = vscode.commands.registerCommand("toolsync.snapshot", async () => {
    const paths = getPaths();
    ensureBaseLayout(paths);
    const snap = await snapshotVscode(paths, output);
    await vscode.window.showInformationMessage(`VS Code 스냅샷 저장 완료 (${snap.extension.length} extensions)`);
  });

  const planCmd = vscode.commands.registerCommand("toolsync.plan", async () => {
    const paths = getPaths();
    ensureBaseLayout(paths);
    await snapshotVscode(paths, output);
    const result = buildAndPersistPlans(paths, output);
    await vscode.window.showInformationMessage(`동기화 계획 생성 완료 (revision=${result.revision}, actions=${result.actionCount})`);
  });

  const applyCmd = vscode.commands.registerCommand("toolsync.apply", async () => {
    const paths = getPaths();
    ensureBaseLayout(paths);
    await snapshotVscode(paths, output);
    buildAndPersistPlans(paths, output);

    const result = await applyVscodePlan(paths, output);
    await snapshotVscode(paths, output);
    const planResult = buildAndPersistPlans(paths, output);

    await vscode.window.showInformationMessage(
      `동기화 적용 완료 (ok=${result.ok}, fail=${result.fail}, remainActions=${planResult.actionCount})`
    );
  });

  context.subscriptions.push(output, statusCmd, initCmd, snapshotCmd, planCmd, applyCmd);
}

export function deactivate(): void {
  // no-op
}
