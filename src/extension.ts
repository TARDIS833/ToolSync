import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildPlans, buildRegistry, readAllSnapshots, writeRegistryAndPlans } from "./toolsync/engine";
import { ensureDir, readJson, writeJson } from "./toolsync/fs";
import {
  appendErrorLog,
  appendRuntimeLog,
  generateDiagnosticReport,
  type LogPolicy,
  type ToolSyncLogPaths
} from "./toolsync/logs";
import { SUPPORTED_TOOLS, type Snapshot, type ToolPlan, type ToolSyncConfig } from "./toolsync/types";

type ToolSyncPaths = {
  syncRoot: string;
  configPath: string;
  statePath: string;
  snapshotsDir: string;
  plansDir: string;
  logsDir: string;
  reportsDir: string;
};

type CycleResult = {
  revision: number;
  actionCount: number;
  applyOk: number;
  applyFail: number;
  changed: boolean;
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
    logsDir: path.join(syncRoot, "logs"),
    reportsDir: path.join(syncRoot, "reports")
  };
}

function getDefaultConfig(): ToolSyncConfig {
  const cfg = vscode.workspace.getConfiguration("toolsync");
  const tools = cfg.get<string[]>("tools", [...SUPPORTED_TOOLS]);
  const allowEnvKeys = cfg.get<string[]>("allowEnvKeys", ["LANG", "LC_ALL", "TERM", "TZ"]);
  const propagateDelete = cfg.get<boolean>("propagateDelete", false);
  const excludeExtensions = cfg.get<string[]>("excludeExtensions", []);
  const excludeMcp = cfg.get<string[]>("excludeMcp", []);
  const excludeSkills = cfg.get<string[]>("excludeSkills", []);
  const applyRetryCount = Math.max(0, cfg.get<number>("applyRetryCount", 1));
  const applyRetryDelaySec = Math.max(1, cfg.get<number>("applyRetryDelaySec", 5));
  const logMaxSizeKb = Math.max(64, cfg.get<number>("logMaxSizeKb", 512));
  const logKeepArchives = Math.max(1, cfg.get<number>("logKeepArchives", 5));
  const reportTailLines = Math.max(10, cfg.get<number>("reportTailLines", 100));

  return {
    tools,
    allowEnvKeys,
    propagateDelete,
    excludeExtensions,
    excludeMcp,
    excludeSkills,
    applyRetryCount,
    applyRetryDelaySec,
    logMaxSizeKb,
    logKeepArchives,
    reportTailLines
  };
}

function ensureBaseLayout(paths: ToolSyncPaths): void {
  ensureDir(paths.syncRoot);
  ensureDir(paths.snapshotsDir);
  ensureDir(paths.plansDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.reportsDir);

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
    propagateDelete: typeof raw.propagateDelete === "boolean" ? raw.propagateDelete : defaults.propagateDelete,
    excludeExtensions: Array.isArray(raw.excludeExtensions) ? raw.excludeExtensions : defaults.excludeExtensions,
    excludeMcp: Array.isArray(raw.excludeMcp) ? raw.excludeMcp : defaults.excludeMcp,
    excludeSkills: Array.isArray(raw.excludeSkills) ? raw.excludeSkills : defaults.excludeSkills,
    applyRetryCount:
      typeof raw.applyRetryCount === "number" ? Math.max(0, raw.applyRetryCount) : defaults.applyRetryCount,
    applyRetryDelaySec:
      typeof raw.applyRetryDelaySec === "number" ? Math.max(1, raw.applyRetryDelaySec) : defaults.applyRetryDelaySec,
    logMaxSizeKb: typeof raw.logMaxSizeKb === "number" ? Math.max(64, raw.logMaxSizeKb) : defaults.logMaxSizeKb,
    logKeepArchives:
      typeof raw.logKeepArchives === "number" ? Math.max(1, raw.logKeepArchives) : defaults.logKeepArchives,
    reportTailLines:
      typeof raw.reportTailLines === "number" ? Math.max(10, raw.reportTailLines) : defaults.reportTailLines
  };
}

function getLogPolicy(config: ToolSyncConfig): LogPolicy {
  return {
    maxLogSizeKb: config.logMaxSizeKb,
    keepArchiveFiles: config.logKeepArchives,
    reportTailLines: config.reportTailLines
  };
}

function getLogPaths(paths: ToolSyncPaths): ToolSyncLogPaths {
  return {
    logsDir: paths.logsDir,
    reportsDir: paths.reportsDir
  };
}

async function snapshotVscode(paths: ToolSyncPaths, output: vscode.OutputChannel): Promise<Snapshot> {
  const config = loadConfig(paths);
  const settings = vscode.workspace.getConfiguration("toolsync");

  const extensionIds = vscode.extensions.all
    .map((ext) => ext.id)
    .filter((id) => id !== "tardis833.toolsync")
    .sort((a, b) => a.localeCompare(b));

  const editorTheme = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme", "Default Dark+");
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

  const prev = readJson<Snapshot | null>(path.join(paths.snapshotsDir, "vscode.json"), null);
  const nextPayload = {
    tool: "vscode",
    extension: extensionIds,
    mcp,
    skill: skills,
    terminal_theme: terminalTheme ? [terminalTheme] : [],
    editor_theme: editorTheme ? [editorTheme] : [],
    env
  };

  const prevPayload = prev
    ? {
        tool: prev.tool,
        extension: prev.extension,
        mcp: prev.mcp,
        skill: prev.skill,
        terminal_theme: prev.terminal_theme,
        editor_theme: prev.editor_theme,
        env: prev.env
      }
    : null;

  const changed = JSON.stringify(prevPayload) !== JSON.stringify(nextPayload);

  const snap: Snapshot = {
    tool: "vscode",
    updatedAt: new Date().toISOString(),
    extension: nextPayload.extension,
    mcp: nextPayload.mcp,
    skill: nextPayload.skill,
    terminal_theme: nextPayload.terminal_theme,
    editor_theme: nextPayload.editor_theme,
    env: nextPayload.env
  };

  if (changed || !prev) {
    writeJson(path.join(paths.snapshotsDir, "vscode.json"), snap);
    output.appendLine(
      `[snapshot] changed extensions=${snap.extension.length} mcp=${snap.mcp.length} skills=${snap.skill.length}`
    );
    return snap;
  }

  output.appendLine("[snapshot] unchanged");
  return prev;
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

function isExcludedAction(action: ToolPlan["actions"][number], config: ToolSyncConfig): boolean {
  if (action.action !== "install") {
    return false;
  }

  if (action.type === "extension") {
    return config.excludeExtensions.includes(action.name);
  }

  if (action.type === "mcp") {
    return config.excludeMcp.includes(action.name);
  }

  if (action.type === "skill") {
    return config.excludeSkills.includes(action.name);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyActionOnce(action: ToolPlan["actions"][number]): Promise<void> {
  if (action.action === "install") {
    if (action.type === "extension") {
      await installVscodeExtension(action.name);
      return;
    }

    if (action.type === "editor_theme") {
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", action.name, vscode.ConfigurationTarget.Global);
      return;
    }

    if (action.type === "terminal_theme") {
      await vscode.workspace.getConfiguration("toolsync").update("terminalTheme", action.name, vscode.ConfigurationTarget.Global);
      return;
    }

    if (action.type === "mcp") {
      const curr = vscode.workspace.getConfiguration("toolsync").get<string[]>("mcp", []);
      const next = Array.from(new Set([...curr, action.name]));
      await vscode.workspace.getConfiguration("toolsync").update("mcp", next, vscode.ConfigurationTarget.Global);
      return;
    }

    if (action.type === "skill") {
      const curr = vscode.workspace.getConfiguration("toolsync").get<string[]>("skills", []);
      const next = Array.from(new Set([...curr, action.name]));
      await vscode.workspace.getConfiguration("toolsync").update("skills", next, vscode.ConfigurationTarget.Global);
      return;
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
    return;
  }

  throw new Error(`Unsupported action: ${JSON.stringify(action)}`);
}

async function applyWithRetry(
  action: ToolPlan["actions"][number],
  retryCount: number,
  retryDelaySec: number
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await applyActionOnce(action);
      return;
    } catch (error) {
      if (attempt >= retryCount) {
        throw error;
      }
      const delayMs = retryDelaySec * 1000 * (attempt + 1);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

async function applyVscodePlan(
  paths: ToolSyncPaths,
  output: vscode.OutputChannel,
  config: ToolSyncConfig
): Promise<{ ok: number; fail: number; skipped: number }> {
  const planPath = path.join(paths.plansDir, "vscode.json");
  const plan = readJson<ToolPlan | null>(planPath, null);

  if (!plan) {
    return { ok: 0, fail: 0, skipped: 0 };
  }

  const logPaths = getLogPaths(paths);
  const logPolicy = getLogPolicy(config);
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const action of plan.actions) {
    if (isExcludedAction(action, config)) {
      skipped += 1;
      output.appendLine(`[apply] skipped by exclude list ${JSON.stringify(action)}`);
      appendRuntimeLog(logPaths, logPolicy, "INFO", "apply", "skipped by exclude", action);
      continue;
    }

    try {
      await applyWithRetry(action, config.applyRetryCount, config.applyRetryDelaySec);
      output.appendLine(`[apply] success ${JSON.stringify(action)}`);
      appendRuntimeLog(logPaths, logPolicy, "INFO", "apply", "action success", action);
      ok += 1;
    } catch (error) {
      fail += 1;
      output.appendLine(`[apply] failed: ${JSON.stringify(action)} error=${String(error)}`);
      appendErrorLog(logPaths, logPolicy, {
        at: new Date().toISOString(),
        source: "apply",
        message: "action failed after retries",
        action,
        error: String(error)
      });
    }
  }

  return { ok, fail, skipped };
}

class AutoSyncController {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pendingReason: string | null = null;
  private mutedUntilMs = 0;
  private lastExternalSnapshotMarker = "";

  constructor(private readonly output: vscode.OutputChannel) {}

  private getSettings(): {
    enabled: boolean;
    intervalSec: number;
    autoApply: boolean;
    onExtensionsChange: boolean;
    onConfigChange: boolean;
  } {
    const cfg = vscode.workspace.getConfiguration("toolsync");
    return {
      enabled: cfg.get<boolean>("autoSyncEnabled", true),
      intervalSec: Math.max(5, cfg.get<number>("autoSyncIntervalSec", 30)),
      autoApply: cfg.get<boolean>("autoApplyVscodePlan", false),
      onExtensionsChange: cfg.get<boolean>("autoSyncOnExtensionChange", true),
      onConfigChange: cfg.get<boolean>("autoSyncOnConfigChange", true)
    };
  }

  public isStarted(): boolean {
    return this.timer !== null;
  }

  private getExternalSnapshotMarker(paths: ToolSyncPaths): string {
    try {
      const files = fs
        .readdirSync(paths.snapshotsDir)
        .filter((name) => name.endsWith(".json") && name !== "vscode.json")
        .sort((a, b) => a.localeCompare(b));

      return files
        .map((name) => {
          const fullPath = path.join(paths.snapshotsDir, name);
          const stat = fs.statSync(fullPath);
          return `${name}:${stat.mtimeMs}:${stat.size}`;
        })
        .join("|");
    } catch {
      return "";
    }
  }

  public async runCycle(reason: string, showToast: boolean): Promise<CycleResult> {
    if (this.running) {
      this.pendingReason = this.pendingReason ? `${this.pendingReason},${reason}` : reason;
      return { revision: 0, actionCount: 0, applyOk: 0, applyFail: 0, changed: false };
    }

    this.running = true;
    const settings = this.getSettings();
    const paths = getPaths();

    try {
      ensureBaseLayout(paths);
      const config = loadConfig(paths);
      const logPaths = getLogPaths(paths);
      const logPolicy = getLogPolicy(config);
      appendRuntimeLog(logPaths, logPolicy, "INFO", "cycle", `start reason=${reason}`);
      const before = readJson<Snapshot | null>(path.join(paths.snapshotsDir, "vscode.json"), null);
      const after = await snapshotVscode(paths, this.output);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const externalMarker = this.getExternalSnapshotMarker(paths);
      const externalChanged = externalMarker !== this.lastExternalSnapshotMarker;

      if (!changed && !externalChanged && reason === "interval") {
        this.output.appendLine("[cycle] skip heavy plan build on unchanged interval snapshot");
        this.lastExternalSnapshotMarker = externalMarker;
        appendRuntimeLog(logPaths, logPolicy, "INFO", "cycle", "skip unchanged interval");
        return { revision: 0, actionCount: 0, applyOk: 0, applyFail: 0, changed: false };
      }

      const planned = buildAndPersistPlans(paths, this.output);

      let applyOk = 0;
      let applyFail = 0;
      let finalPlan = planned;

      if (settings.autoApply) {
        this.mutedUntilMs = Date.now() + 1500;
        const applied = await applyVscodePlan(paths, this.output, config);
        applyOk = applied.ok;
        applyFail = applied.fail;
        await snapshotVscode(paths, this.output);
        finalPlan = buildAndPersistPlans(paths, this.output);
      }

      this.output.appendLine(`[cycle] reason=${reason} autoApply=${settings.autoApply} actions=${finalPlan.actionCount}`);
      appendRuntimeLog(
        logPaths,
        logPolicy,
        "INFO",
        "cycle",
        `done reason=${reason} revision=${finalPlan.revision} actions=${finalPlan.actionCount} fail=${applyFail}`
      );
      this.lastExternalSnapshotMarker = externalMarker;

      if (showToast) {
        await vscode.window.showInformationMessage(
          `ToolSync 동기화 완료 (revision=${finalPlan.revision}, remain=${finalPlan.actionCount}, ok=${applyOk}, fail=${applyFail})`
        );
      }

      return {
        revision: finalPlan.revision,
        actionCount: finalPlan.actionCount,
        applyOk,
        applyFail,
        changed
      };
    } finally {
      this.running = false;
      if (this.pendingReason) {
        const next = this.pendingReason;
        this.pendingReason = null;
        void this.runCycle(`queued:${next}`, false);
      }
    }
  }

  public start(context: vscode.ExtensionContext): void {
    if (this.timer) {
      return;
    }

    const settings = this.getSettings();
    this.timer = setInterval(() => {
      void this.runCycle("interval", false);
    }, settings.intervalSec * 1000);

    const extChanged = vscode.extensions.onDidChange(() => {
      if (!this.getSettings().onExtensionsChange) {
        return;
      }
      void this.runCycle("extensions.onDidChange", false);
    });

    const cfgChanged = vscode.workspace.onDidChangeConfiguration((e) => {
      if (Date.now() < this.mutedUntilMs) {
        return;
      }

      const settingsNow = this.getSettings();
      const toolsyncChanged = e.affectsConfiguration("toolsync");
      const themeChanged = e.affectsConfiguration("workbench.colorTheme");

      if (toolsyncChanged && settingsNow.onConfigChange) {
        void this.runCycle("config.onDidChange", false);
      } else if (themeChanged && settingsNow.onConfigChange) {
        void this.runCycle("theme.onDidChange", false);
      }

      if (toolsyncChanged && this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          void this.runCycle("interval", false);
        }, this.getSettings().intervalSec * 1000);
      }
    });

    context.subscriptions.push(extChanged, cfgChanged, new vscode.Disposable(() => this.stop()));
    this.output.appendLine(`[auto] started interval=${settings.intervalSec}s`);
    void this.runCycle("auto.start", false);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.output.appendLine("[auto] stopped");
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ToolSync");
  const auto = new AutoSyncController(output);

  const statusCmd = vscode.commands.registerCommand("toolsync.hello", async () => {
    const paths = getPaths();
    const mode = auto.isStarted() ? "AUTO=ON" : "AUTO=OFF";
    const message = [
      "ToolSync는 로컬 전용으로 동작합니다.",
      `syncRoot: ${paths.syncRoot}`,
      `mode: ${mode}`,
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
    const result = await auto.runCycle("command.plan", false);
    await vscode.window.showInformationMessage(
      `동기화 계획 생성 완료 (revision=${result.revision}, actions=${result.actionCount}, changed=${result.changed})`
    );
  });

  const applyCmd = vscode.commands.registerCommand("toolsync.apply", async () => {
    const paths = getPaths();
    const config = loadConfig(paths);
    const logPaths = getLogPaths(paths);
    const logPolicy = getLogPolicy(config);
    ensureBaseLayout(paths);
    await snapshotVscode(paths, output);
    buildAndPersistPlans(paths, output);

    const result = await applyVscodePlan(paths, output, config);
    await snapshotVscode(paths, output);
    const finalPlan = buildAndPersistPlans(paths, output);
    appendRuntimeLog(
      logPaths,
      logPolicy,
      "INFO",
      "command.apply",
      `done ok=${result.ok} fail=${result.fail} skipped=${result.skipped} remain=${finalPlan.actionCount}`
    );

    await vscode.window.showInformationMessage(
      `동기화 적용 완료 (ok=${result.ok}, fail=${result.fail}, skipped=${result.skipped}, remainActions=${finalPlan.actionCount})`
    );
  });

  const syncNowCmd = vscode.commands.registerCommand("toolsync.syncNow", async () => {
    await auto.runCycle("command.syncNow", true);
  });

  const autoStartCmd = vscode.commands.registerCommand("toolsync.autoStart", async () => {
    auto.start(context);
    await vscode.window.showInformationMessage("ToolSync 자동 동기화 시작");
  });

  const autoStopCmd = vscode.commands.registerCommand("toolsync.autoStop", async () => {
    auto.stop();
    await vscode.window.showInformationMessage("ToolSync 자동 동기화 중지");
  });

  const reportCmd = vscode.commands.registerCommand("toolsync.report", async () => {
    const paths = getPaths();
    ensureBaseLayout(paths);
    const config = loadConfig(paths);
    const reportPath = generateDiagnosticReport(paths.syncRoot, getLogPaths(paths), getLogPolicy(config), "command.report");
    await vscode.window.showInformationMessage(`진단 리포트 생성 완료: ${reportPath}`);
  });

  context.subscriptions.push(
    output,
    statusCmd,
    initCmd,
    snapshotCmd,
    planCmd,
    applyCmd,
    syncNowCmd,
    autoStartCmd,
    autoStopCmd,
    reportCmd
  );

  if (vscode.workspace.getConfiguration("toolsync").get<boolean>("autoSyncEnabled", true)) {
    auto.start(context);
  }
}

export function deactivate(): void {
  // no-op
}
