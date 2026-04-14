/**
 * JSON-line protocol between daemon and extension host.
 * Each message is a single JSON object followed by \n.
 */

// Extension → Daemon requests
export type DaemonRequest =
  | { type: 'create'; uid: string; cols: number; rows: number; cwd: string; command?: string; env?: Record<string, string> }
  | { type: 'input'; uid: string; data: string }
  | { type: 'resize'; uid: string; cols: number; rows: number }
  | { type: 'kill'; uid: string }
  | { type: 'list' }
  | { type: 'replay'; uid: string }
  | { type: 'ping' }
  | { type: 'shutdown' };

// Daemon → Extension responses/events
export type DaemonEvent =
  | { type: 'output'; uid: string; data: string }
  | { type: 'exit'; uid: string; exitCode: number }
  | { type: 'list-result'; sessions: Array<{ uid: string; pid: number; processName: string }> }
  | { type: 'replay-result'; uid: string; data: string }
  | { type: 'created'; uid: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };
