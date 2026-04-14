/**
 * Daemon server process — manages PTYs and communicates over a Unix domain socket.
 * This is a standalone Node.js process, NOT loaded by VSCode.
 *
 * Usage: node out/daemon.js <socket-path>
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, exec } from 'child_process';
import * as pty from 'node-pty';
import type { DaemonRequest, DaemonEvent } from './protocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RING_BUFFER_MAX = 100_000; // ~100K characters per session
const PROCESS_NAME_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Session {
  uid: string;
  ptyProcess: pty.IPty;
  pid: number;
  processName: string;
  ringBuffer: string;
  processNameTimer: NodeJS.Timeout | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();
const clients = new Set<net.Socket>();

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------

function appendToRingBuffer(session: Session, data: string): void {
  session.ringBuffer += data;
  if (session.ringBuffer.length > RING_BUFFER_MAX) {
    // Keep the last ~half of the buffer
    session.ringBuffer = session.ringBuffer.slice(-Math.floor(RING_BUFFER_MAX / 2));
  }
}

// ---------------------------------------------------------------------------
// Client write helpers
// ---------------------------------------------------------------------------

function sendToClient(socket: net.Socket, event: DaemonEvent): void {
  if (socket.writable) {
    socket.write(JSON.stringify(event) + '\n');
  }
}

function broadcast(event: DaemonEvent): void {
  const line = JSON.stringify(event) + '\n';
  for (const client of clients) {
    if (client.writable) {
      client.write(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Process name polling
// ---------------------------------------------------------------------------

function startProcessNamePolling(session: Session): NodeJS.Timeout {
  return setInterval(() => {
    exec(`ps -p ${session.pid} -o comm=`, (err, stdout) => {
      if (!err) {
        session.processName = stdout.trim();
      }
    });
  }, PROCESS_NAME_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Build a clean env for PTY sessions. Strips internal VSCode extension host
 * vars that aren't meant for terminals (e.g., VSCODE_CRASH_REPORTER_PROCESS_TYPE)
 * and adds the vars that the built-in terminal normally has.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const stripPrefixes = [
    'VSCODE_CRASH_REPORTER_',
    'VSCODE_ESM_',
    'VSCODE_HANDLES_',
    'VSCODE_IPC_HOOK',
    'VSCODE_L10N_',
    'VSCODE_NLS_',
    'VSCODE_PID',
    'VSCODE_CWD',
    'VSCODE_CODE_CACHE_PATH',
  ];

  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (stripPrefixes.some((p) => key.startsWith(p))) continue;
    env[key] = val;
  }

  // Add vars that VSCode's built-in terminal sets
  env.TERM_PROGRAM = 'vscode';
  env.TERM_PROGRAM_VERSION = '1.115.0';
  env.COLORTERM = 'truecolor';
  env.VSCODE_INJECTION = '1';

  return env;
}

function createSession(
  uid: string,
  cols: number,
  rows: number,
  cwd: string,
  command?: string,
  extraEnv?: Record<string, string>,
): Session {
  const shell = process.env.SHELL || '/bin/bash';
  const spawnCmd = shell;
  const spawnArgs = command ? ['-l', '-c', command] : ['-l'];

  const ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv(), ...extraEnv },
  });

  const session: Session = {
    uid,
    ptyProcess,
    pid: ptyProcess.pid,
    processName: spawnCmd,
    ringBuffer: '',
    processNameTimer: null,
  };

  ptyProcess.onData((data: string) => {
    appendToRingBuffer(session, data);
    broadcast({ type: 'output', uid, data });
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    clearInterval(session.processNameTimer);
    sessions.delete(uid);
    broadcast({ type: 'exit', uid, exitCode });
  });

  session.processNameTimer = startProcessNamePolling(session);
  sessions.set(uid, session);
  return session;
}

function destroySession(uid: string): void {
  const session = sessions.get(uid);
  if (!session) {
    return;
  }
  clearInterval(session.processNameTimer);
  try {
    session.ptyProcess.kill();
  } catch {
    // Already dead — ignore
  }
  sessions.delete(uid);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(socket: net.Socket, req: DaemonRequest): void {
  switch (req.type) {
    case 'ping': {
      sendToClient(socket, { type: 'pong' });
      break;
    }

    case 'create': {
      if (sessions.has(req.uid)) {
        sendToClient(socket, { type: 'error', message: `Session ${req.uid} already exists` });
        return;
      }
      try {
        createSession(req.uid, req.cols, req.rows, req.cwd, req.command, req.env);
        sendToClient(socket, { type: 'created', uid: req.uid });
      } catch (err) {
        sendToClient(socket, {
          type: 'error',
          message: `Failed to create session: ${(err as Error).message}`,
        });
      }
      break;
    }

    case 'input': {
      const session = sessions.get(req.uid);
      if (!session) {
        sendToClient(socket, { type: 'error', message: `Session ${req.uid} not found` });
        return;
      }
      session.ptyProcess.write(req.data);
      break;
    }

    case 'resize': {
      const session = sessions.get(req.uid);
      if (!session) {
        sendToClient(socket, { type: 'error', message: `Session ${req.uid} not found` });
        return;
      }
      session.ptyProcess.resize(req.cols, req.rows);
      break;
    }

    case 'kill': {
      if (!sessions.has(req.uid)) {
        sendToClient(socket, { type: 'error', message: `Session ${req.uid} not found` });
        return;
      }
      destroySession(req.uid);
      break;
    }

    case 'list': {
      const sessionList = Array.from(sessions.values()).map((s) => ({
        uid: s.uid,
        pid: s.pid,
        processName: s.processName,
      }));
      sendToClient(socket, { type: 'list-result', sessions: sessionList });
      break;
    }

    case 'replay': {
      const session = sessions.get(req.uid);
      if (!session) {
        sendToClient(socket, { type: 'error', message: `Session ${req.uid} not found` });
        return;
      }
      sendToClient(socket, { type: 'replay-result', uid: req.uid, data: session.ringBuffer });
      break;
    }

    case 'shutdown': {
      for (const uid of sessions.keys()) {
        destroySession(uid);
      }
      process.exit(0);
      break;
    }

    default: {
      sendToClient(socket, {
        type: 'error',
        message: `Unknown request type: ${(req as DaemonRequest & { type: string }).type}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

function startServer(socketPath: string): void {
  // Clean up stale socket file
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((socket) => {
    clients.add(socket);

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      // Last element is either '' (complete) or an incomplete line
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let req: DaemonRequest;
        try {
          req = JSON.parse(trimmed) as DaemonRequest;
        } catch {
          sendToClient(socket, { type: 'error', message: 'Invalid JSON' });
          continue;
        }
        handleRequest(socket, req);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
    });

    socket.on('error', (err) => {
      console.error('[daemon] Socket error:', err.message);
      clients.delete(socket);
    });
  });

  server.on('error', (err) => {
    console.error('[daemon] Server error:', err);
    process.exit(1);
  });

  server.listen(socketPath, () => {
    console.log(`[daemon] Listening on ${socketPath}`);
  });

  // Ignore SIGTERM/SIGHUP — the daemon must survive the parent (VSCode) dying.
  // The extension host sends SIGTERM to children on reload/deactivation.
  // Only shut down when there are no sessions left and no clients connected,
  // or via an explicit 'shutdown' command (not yet implemented).
  process.on('SIGTERM', () => {
    console.log('[daemon] Ignoring SIGTERM (staying alive for session persistence)');
  });
  process.on('SIGHUP', () => {
    console.log('[daemon] Ignoring SIGHUP');
  });

  // SIGINT (Ctrl+C) is only for manual debugging — actually shut down
  process.on('SIGINT', () => {
    console.log('[daemon] SIGINT received, shutting down...');
    for (const uid of sessions.keys()) {
      destroySession(uid);
    }
    server.close();
    try { fs.unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const socketPath = process.argv[2];
if (!socketPath) {
  console.error('Usage: node out/daemon.js <socket-path>');
  process.exit(1);
}

startServer(socketPath);
