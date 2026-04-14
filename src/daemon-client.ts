import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { existsSync } from 'fs';
import { spawn as cpSpawn, execSync } from 'child_process';
import type { DaemonRequest, DaemonEvent } from './daemon/protocol';

type EventCallback = (event: DaemonEvent) => void;

export class DaemonClient {
  private socket: net.Socket | null = null;
  private pending = '';
  private listeners: EventCallback[] = [];
  private responseWaiters = new Map<string, (event: DaemonEvent) => void>();
  private readonly socketPath: string;
  private readonly daemonScriptPath: string;

  constructor(workspacePath: string, extensionPath: string) {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
    const socketDir = path.join(os.tmpdir(), 'agentterm');
    this.socketPath = path.join(socketDir, `daemon-${hash}.sock`);
    this.daemonScriptPath = path.join(extensionPath, 'out', 'daemon.js');
  }

  async connect(): Promise<void> {
    // Try connecting to existing daemon first
    try {
      await this.tryConnect();
      await this.request({ type: 'ping' }, 'pong', 2000);
      return;
    } catch {
      // No daemon running — start one
    }

    await this.startDaemon();
    await this.tryConnect();
    await this.request({ type: 'ping' }, 'pong', 5000);
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 3000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.setupSocket();
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupSocket(): void {
    if (!this.socket) return;

    this.socket.on('data', (chunk) => {
      this.pending += chunk.toString();
      let idx: number;
      while ((idx = this.pending.indexOf('\n')) !== -1) {
        const line = this.pending.slice(0, idx);
        this.pending = this.pending.slice(idx + 1);
        try {
          const event = JSON.parse(line) as DaemonEvent;
          const waiter = this.responseWaiters.get(event.type);
          if (waiter) {
            this.responseWaiters.delete(event.type);
            waiter(event);
          }
          for (const cb of this.listeners) {
            cb(event);
          }
        } catch {}
      }
    });

    this.socket.on('close', () => {
      this.socket = null;
    });

    this.socket.on('error', () => {
      this.socket = null;
    });
  }

  private async startDaemon(): Promise<void> {
    const nodePath = this.findNodeBinary();

    // Use 'setsid' to create a new session, fully detaching from VSCode's
    // process tree. Without this, VSCode kills all descendants on reload.
    // On macOS, /usr/bin/setsid doesn't exist, but we can use 'nohup' + shell.
    const isLinux = process.platform === 'linux';
    const child = isLinux
      ? cpSpawn('setsid', [nodePath, this.daemonScriptPath, this.socketPath], {
          detached: true,
          stdio: 'ignore',
        })
      : cpSpawn('/bin/sh', [
          '-c',
          `exec nohup "${nodePath}" "${this.daemonScriptPath}" "${this.socketPath}" >/dev/null 2>&1 &`,
        ], {
          detached: true,
          stdio: 'ignore',
        });
    child.unref();

    // Wait for socket file to appear
    const maxWait = 5000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (existsSync(this.socketPath)) {
        await new Promise((r) => setTimeout(r, 100));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Daemon failed to start');
  }

  private findNodeBinary(): string {
    try {
      const p = execSync('which node', { encoding: 'utf-8', timeout: 2000 }).trim();
      if (p) return p;
    } catch {}
    return process.execPath;
  }

  send(req: DaemonRequest): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(req) + '\n');
    }
  }

  request(req: DaemonRequest, expectType: string, timeoutMs = 5000): Promise<DaemonEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseWaiters.delete(expectType);
        reject(new Error(`Timeout waiting for ${expectType}`));
      }, timeoutMs);

      this.responseWaiters.set(expectType, (event) => {
        clearTimeout(timer);
        resolve(event);
      });

      this.send(req);
    });
  }

  onEvent(cb: EventCallback): void {
    this.listeners.push(cb);
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = null;
    this.listeners = [];
    this.responseWaiters.clear();
  }
}
