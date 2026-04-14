import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DaemonClient } from './daemon-client';
import { TabStateManager } from './tab-state';
import type { TabInfo, ExtensionToWebviewMessage, TerminalTheme } from './types';
import type { DaemonEvent } from './daemon/protocol';

export class AgentTerminalViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentTerminal';
  private view?: vscode.WebviewView;
  private activeUid: string | null = null;
  private contextClickedUid: string | null = null;
  private processNameInterval?: ReturnType<typeof setInterval>;
  private activeSessions = new Set<string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly daemon: DaemonClient,
    private readonly tabState: TabStateManager,
    private readonly workspacePath: string
  ) {
    // Listen for daemon events
    this.daemon.onEvent((event) => this.handleDaemonEvent(event));
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    webviewView.onDidDispose(() => {
      if (this.processNameInterval) {
        clearInterval(this.processNameInterval);
      }
    });

    this.processNameInterval = setInterval(() => this.updateProcessNames(), 2000);
  }

  private handleDaemonEvent(event: DaemonEvent): void {
    switch (event.type) {
      case 'output':
        if (this.activeSessions.has(event.uid)) {
          this.postMessage({ type: 'terminal-data', uid: event.uid, data: event.data });
        }
        break;

      case 'replay-result':
        if (event.data && this.activeSessions.has(event.uid)) {
          this.postMessage({ type: 'terminal-data', uid: event.uid, data: event.data });
        }
        break;

      case 'exit':
        if (this.activeSessions.has(event.uid)) {
          this.activeSessions.delete(event.uid);
          this.postMessage({ type: 'session-ended', uid: event.uid });
        }
        break;
    }
  }

  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const scrollback = vscode.workspace.getConfiguration('agentTerminal').get<number>('scrollback', 5000);
        this.postMessage({ type: 'config-updated', scrollback });
        this.postMessage({ type: 'theme-changed', theme: this.getTerminalTheme() });
        await this.restoreSessions();
        break;
      }

      case 'terminal-input':
        this.daemon.send({ type: 'input', uid: msg.uid, data: msg.data });
        break;

      case 'tab-selected':
        this.activeUid = msg.uid;
        this.sendTabsUpdate();
        break;

      case 'resize':
        this.daemon.send({ type: 'resize', uid: msg.uid, cols: msg.cols, rows: msg.rows });
        break;

      case 'tab-renamed':
        await this.tabState.renameTab(msg.uid, msg.name, true);
        this.sendTabsUpdate();
        break;

      case 'tab-killed':
        await this.killTab(msg.uid);
        break;

      case 'tab-reordered':
        await this.tabState.reorderTabs(msg.uids);
        this.sendTabsUpdate();
        break;

      case 'tab-restart':
        await this.restartTab(msg.uid);
        break;

      case 'tab-context-click':
        this.contextClickedUid = msg.uid;
        break;

      case 'open-link':
        vscode.env.openExternal(vscode.Uri.parse(msg.uri));
        break;
    }
  }

  private sendCreateSession(uid: string): void {
    const config = vscode.workspace.getConfiguration('agentTerminal');
    const startupCommand = config.get<string>('startupCommand', '');

    // Find CLAUDE_CODE_SSE_PORT from lock files. The Claude Code extension
    // sets this via VSCode's EnvironmentVariableCollection (not process.env).
    const env: Record<string, string> = {};
    const ssePort = this.findClaudeSsePort();
    if (ssePort) env.CLAUDE_CODE_SSE_PORT = ssePort;

    this.daemon.send({
      type: 'create',
      uid,
      cols: 80,
      rows: 24,
      cwd: this.workspacePath,
      command: startupCommand || undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    });
  }

  private findClaudeSsePort(): string | undefined {
    try {
      const fs = require('fs');
      const lockDir = require('path').join(process.env.HOME || '', '.claude', 'ide');
      if (!fs.existsSync(lockDir)) return undefined;

      for (const file of fs.readdirSync(lockDir) as string[]) {
        if (!file.endsWith('.lock')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(require('path').join(lockDir, file), 'utf-8'));
          if (data.workspaceFolders?.includes(this.workspacePath)) {
            return file.replace('.lock', '');
          }
        } catch {}
      }
    } catch {}
    return undefined;
  }

  async createNewTab(): Promise<void> {
    // Reconnect to daemon if it was shut down
    if (!this.daemon.connected) {
      await this.daemon.connect();
    }

    const uid = generateUid();
    const tabs = this.tabState.getTabs();

    await this.tabState.addTab({ uid, name: 'shell', order: tabs.length });

    // Mark as active BEFORE sending create so we catch the output events
    this.activeSessions.add(uid);
    this.activeUid = uid;
    this.sendTabsUpdate();

    this.sendCreateSession(uid);
  }

  async killTab(uid: string): Promise<void> {
    this.daemon.send({ type: 'kill', uid });
    this.activeSessions.delete(uid);
    await this.tabState.removeTab(uid);

    const tabs = this.tabState.getTabs();
    if (this.activeUid === uid) {
      this.activeUid = tabs.length > 0 ? tabs[0].uid : null;
    }

    this.sendTabsUpdate();

    // Shut down daemon when all tabs are gone
    if (tabs.length === 0 && this.activeSessions.size === 0) {
      this.daemon.send({ type: 'shutdown' });
    }
  }

  async renameTab(): Promise<void> {
    await this.renameTabByUid(this.activeUid);
  }

  async renameTabByUid(uid: string | null): Promise<void> {
    if (!uid) return;
    this.postMessage({ type: 'start-rename', uid });
  }

  getActiveUid(): string | null {
    return this.activeUid;
  }

  getTargetUid(): string | null {
    const uid = this.contextClickedUid ?? this.activeUid;
    this.contextClickedUid = null;
    return uid;
  }

  private async restoreSessions(): Promise<void> {
    const tabs = this.tabState.getTabs();
    if (tabs.length === 0) {
      await this.createNewTab();
      return;
    }

    // Ask daemon which sessions are still alive
    let liveSessions: Set<string>;
    try {
      const result = await this.daemon.request({ type: 'list' }, 'list-result', 3000);
      if (result.type === 'list-result') {
        liveSessions = new Set(result.sessions.map((s) => s.uid));
      } else {
        liveSessions = new Set();
      }
    } catch {
      liveSessions = new Set();
    }

    const deadSessions: string[] = [];

    for (const tab of tabs) {
      if (liveSessions.has(tab.uid)) {
        this.activeSessions.add(tab.uid);
        // Replay buffered output to restore xterm.js state
        this.daemon.send({ type: 'replay', uid: tab.uid });
      } else {
        deadSessions.push(tab.name);
        this.postMessage({ type: 'session-ended', uid: tab.uid });
      }
    }

    if (deadSessions.length > 0) {
      vscode.window.showWarningMessage(
        `Agent Terminal: ${deadSessions.length === 1 ? `session '${deadSessions[0]}' is` : `${deadSessions.length} sessions are`} no longer running`
      );
    }

    this.activeUid = tabs[0].uid;
    this.sendTabsUpdate();
  }

  private async restartTab(uid: string): Promise<void> {
    this.sendCreateSession(uid);
    this.activeSessions.add(uid);
    this.sendTabsUpdate();
  }

  private sendTabsUpdate(): void {
    const tabs = this.tabState.getTabs();
    vscode.commands.executeCommand('setContext', 'agentTerminal.singleTab', tabs.length <= 1);
    this.postMessage({
      type: 'tabs-updated',
      tabs,
      activeUid: this.activeUid,
    });
  }

  private postMessage(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private async updateProcessNames(): Promise<void> {
    if (this.activeSessions.size === 0) return;

    const tabs = this.tabState.getTabs();
    const hasAutoNamedTabs = tabs.some(t => !t.userRenamed && this.activeSessions.has(t.uid));
    if (!hasAutoNamedTabs) return;

    try {
      const result = await this.daemon.request({ type: 'list' }, 'list-result', 2000);
      if (result.type !== 'list-result') return;

      const nameMap = new Map(result.sessions.map((s) => [s.uid, s.processName]));
      let changed = false;

      for (const tab of tabs) {
        if (tab.userRenamed) continue;
        const name = nameMap.get(tab.uid);
        if (name && name !== tab.name) {
          await this.tabState.renameTab(tab.uid, name);
          changed = true;
        }
      }

      if (changed) {
        this.sendTabsUpdate();
      }
    } catch {
      // Daemon may be temporarily unreachable
    }
  }

  private getTerminalTheme(): TerminalTheme {
    const termConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const editorConfig = vscode.workspace.getConfiguration('editor');
    return {
      fontFamily: termConfig.get<string>('fontFamily', '') || editorConfig.get<string>('fontFamily', 'monospace'),
      fontSize: termConfig.get<number>('fontSize', 0) || editorConfig.get<number>('fontSize', 14),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js')
    );
    const xtermCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'xterm.css')
    );
    const stylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.css')
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'codicon.css')
    );
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${xtermCssUri}">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${stylesheetUri}">
</head>
<body>
  <div class="container">
    <div class="tab-sidebar" id="tab-sidebar">
      <div class="tab-list" id="tab-list"></div>
      <div class="tab-sidebar-resize" id="tab-sidebar-resize"></div>
    </div>
    <div class="terminal-area" id="terminal-area"></div>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public sendThemeUpdate(): void {
    this.postMessage({ type: 'theme-changed', theme: this.getTerminalTheme() });
  }

}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateUid(): string {
  return crypto.randomBytes(3).toString('hex');
}
