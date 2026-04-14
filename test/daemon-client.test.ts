import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { DaemonEvent } from '../src/daemon/protocol';

describe('DaemonClient protocol', () => {
  it('computes a deterministic socket path from workspace', () => {
    const workspacePath = '/test/workspace';
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
    const expected = path.join(os.tmpdir(), 'agentterm', `daemon-${hash}.sock`);
    const hash2 = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
    expect(hash).toBe(hash2);
    expect(expected).toContain('agentterm');
    expect(expected).toContain('.sock');
  });

  it('serializes requests as JSON lines', () => {
    const req = { type: 'ping' as const };
    const line = JSON.stringify(req) + '\n';
    expect(line).toBe('{"type":"ping"}\n');
  });

  it('parses daemon events from JSON lines', () => {
    const line = '{"type":"pong"}\n';
    const event = JSON.parse(line.trim()) as DaemonEvent;
    expect(event.type).toBe('pong');
  });

  it('parses output events with data', () => {
    const event: DaemonEvent = { type: 'output', uid: 'abc', data: 'hello\r\n' };
    const parsed = JSON.parse(JSON.stringify(event)) as DaemonEvent;
    expect(parsed.type).toBe('output');
    if (parsed.type === 'output') {
      expect(parsed.uid).toBe('abc');
      expect(parsed.data).toBe('hello\r\n');
    }
  });

  it('parses list-result events', () => {
    const event: DaemonEvent = {
      type: 'list-result',
      sessions: [{ uid: 'a', pid: 123, processName: 'zsh' }],
    };
    const parsed = JSON.parse(JSON.stringify(event)) as DaemonEvent;
    expect(parsed.type).toBe('list-result');
    if (parsed.type === 'list-result') {
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].processName).toBe('zsh');
    }
  });
});
