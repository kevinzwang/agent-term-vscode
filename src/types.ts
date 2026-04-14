export interface TabInfo {
  uid: string;
  name: string;
  order: number;
  userRenamed?: boolean;
}

// Extension host → Webview messages
export type ExtensionToWebviewMessage =
  | { type: 'terminal-data'; uid: string; data: string }
  | { type: 'tabs-updated'; tabs: TabInfo[]; activeUid: string | null }
  | { type: 'session-ended'; uid: string }
  | { type: 'theme-changed'; theme: TerminalTheme }
  | { type: 'config-updated'; scrollback: number }
  | { type: 'start-rename'; uid: string };

// Webview → Extension host messages
export type WebviewToExtensionMessage =
  | { type: 'terminal-input'; uid: string; data: string }
  | { type: 'tab-selected'; uid: string }
  | { type: 'tab-reordered'; uids: string[] }
  | { type: 'tab-renamed'; uid: string; name: string }
  | { type: 'tab-killed'; uid: string }
  | { type: 'tab-restart'; uid: string }
  | { type: 'ready' }
  | { type: 'resize'; uid: string; cols: number; rows: number }
  | { type: 'tab-context-click'; uid: string };

export interface TerminalTheme {
  fontFamily: string;
  fontSize: number;
}
