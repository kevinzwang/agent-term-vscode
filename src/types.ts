export interface TabInfo {
  uid: string;
  name: string;
  order: number;
}

export type SessionStatus = 'alive' | 'dead';

// Extension host → Webview messages
export type ExtensionToWebviewMessage =
  | { type: 'terminal-data'; uid: string; data: string }
  | { type: 'tabs-updated'; tabs: TabInfo[]; activeUid: string | null }
  | { type: 'session-ended'; uid: string }
  | { type: 'theme-changed'; theme: TerminalTheme };

// Webview → Extension host messages
export type WebviewToExtensionMessage =
  | { type: 'terminal-input'; uid: string; data: string }
  | { type: 'tab-selected'; uid: string }
  | { type: 'tab-reordered'; uids: string[] }
  | { type: 'tab-renamed'; uid: string; name: string }
  | { type: 'tab-killed'; uid: string }
  | { type: 'tab-restart'; uid: string }
  | { type: 'ready' }
  | { type: 'resize'; uid: string; cols: number; rows: number };

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  fontFamily: string;
  fontSize: number;
}
