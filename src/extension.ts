import * as vscode from 'vscode';
import { AgentTerminalViewProvider } from './webview-provider';
import { DaemonClient } from './daemon-client';
import { TabStateManager } from './tab-state';

let provider: AgentTerminalViewProvider;
let daemonClient: DaemonClient;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/tmp';

  daemonClient = new DaemonClient(workspacePath, context.extensionPath);

  try {
    await daemonClient.connect();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Agent Terminal: Failed to start daemon. Make sure Node.js is installed. Error: ${err}`
    );
    return;
  }

  const tabState = new TabStateManager(context.workspaceState);

  provider = new AgentTerminalViewProvider(
    context.extensionUri,
    daemonClient,
    tabState,
    workspacePath
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentTerminalViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentTerminal.newTab', () => provider.createNewTab()),
    vscode.commands.registerCommand('agentTerminal.killTab', () => {
      const uid = provider.getTargetUid();
      if (uid) {
        provider.killTab(uid);
      }
    }),
    vscode.commands.registerCommand('agentTerminal.renameTab', () => {
      const uid = provider.getTargetUid();
      if (uid) {
        provider.renameTabByUid(uid);
      }
    }),
    vscode.commands.registerCommand('agentTerminal.focusTerminal', () => {
      vscode.commands.executeCommand('agentTerminal.focus');
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      provider.sendThemeUpdate();
    })
  );

  context.subscriptions.push({ dispose: () => daemonClient.dispose() });
}

export function deactivate(): void {
  daemonClient?.dispose();
}
