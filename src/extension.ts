import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

function resolveHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand("toolsync.hello", async () => {
    const config = vscode.workspace.getConfiguration("toolsync");
    const syncRoot = resolveHomePath(config.get<string>("syncRoot", "~/ToolSync"));

    const message = [
      "ToolSync는 로컬 전용으로 동작합니다.",
      `syncRoot: ${syncRoot}`,
      "Marketplace 자동 업데이트 없이 VSIX 설치 방식으로 운영됩니다."
    ].join("\n");

    await vscode.window.showInformationMessage(message, { modal: true });
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {
  // no-op
}
