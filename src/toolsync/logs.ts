import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, readJson, writeJson } from "./fs";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export type ToolSyncLogPaths = {
  logsDir: string;
  reportsDir: string;
};

export type LogPolicy = {
  maxLogSizeKb: number;
  keepArchiveFiles: number;
  reportTailLines: number;
};

export type ErrorEvent = {
  at: string;
  source: string;
  message: string;
  action?: unknown;
  error?: string;
};

function nowCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getRuntimeLogFile(paths: ToolSyncLogPaths): string {
  return path.join(paths.logsDir, "runtime.log");
}

function getErrorLogFile(paths: ToolSyncLogPaths): string {
  return path.join(paths.logsDir, "errors.ndjson");
}

function getArchiveDir(paths: ToolSyncLogPaths): string {
  return path.join(paths.logsDir, "archive");
}

function appendLine(filePath: string, line: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

function sortByMtimeDesc(filePaths: string[]): string[] {
  return filePaths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function rotateIfNeeded(filePath: string, archiveDir: string, prefix: string, policy: LogPolicy): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= policy.maxLogSizeKb * 1024) {
    return;
  }

  ensureDir(archiveDir);
  const archivedPath = path.join(archiveDir, `${prefix}-${nowCompact()}.log`);
  fs.renameSync(filePath, archivedPath);

  const archives = sortByMtimeDesc(
    fs
      .readdirSync(archiveDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(archiveDir, name))
  );

  const stale = archives.slice(policy.keepArchiveFiles);
  for (const f of stale) {
    fs.unlinkSync(f);
  }
}

export function appendRuntimeLog(
  paths: ToolSyncLogPaths,
  policy: LogPolicy,
  level: LogLevel,
  source: string,
  message: string,
  data?: unknown
): void {
  const payload = {
    at: new Date().toISOString(),
    level,
    source,
    message,
    data
  };

  const filePath = getRuntimeLogFile(paths);
  appendLine(filePath, JSON.stringify(payload));
  rotateIfNeeded(filePath, getArchiveDir(paths), "runtime", policy);
}

export function appendErrorLog(paths: ToolSyncLogPaths, policy: LogPolicy, event: ErrorEvent): void {
  const filePath = getErrorLogFile(paths);
  appendLine(filePath, JSON.stringify(event));
  rotateIfNeeded(filePath, getArchiveDir(paths), "errors", policy);
}

export function readTailLines(filePath: string, lineCount: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split(/\r?\n/).filter(Boolean).slice(-lineCount);
}

export function generateDiagnosticReport(
  root: string,
  paths: ToolSyncLogPaths,
  policy: LogPolicy,
  reason: string
): string {
  ensureDir(paths.reportsDir);
  const reportPath = path.join(paths.reportsDir, `diagnostic-${nowCompact()}.json`);

  const config = readJson<Record<string, unknown>>(path.join(root, "config.json"), {});
  const state = readJson<Record<string, unknown>>(path.join(root, "state.json"), {});
  const registry = readJson<Record<string, unknown>>(path.join(root, "registry.json"), {});

  const runtimeTail = readTailLines(getRuntimeLogFile(paths), policy.reportTailLines);
  const errorTail = readTailLines(getErrorLogFile(paths), policy.reportTailLines);

  const report = {
    generatedAt: new Date().toISOString(),
    reason,
    config,
    state,
    registrySummary: {
      revision: registry.revision,
      updatedAt: registry.updatedAt,
      tools: Array.isArray(registry.tools) ? registry.tools : []
    },
    runtimeTail,
    errorTail
  };

  writeJson(reportPath, report);
  return reportPath;
}
