import { describe, it, expect, beforeEach } from 'vitest';
import { TabStateManager } from '../src/tab-state';
import type { TabInfo } from '../src/types';

// Mock VSCode Memento
class MockMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.store.get(key) as T) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

describe('TabStateManager', () => {
  let memento: MockMemento;
  let manager: TabStateManager;

  beforeEach(() => {
    memento = new MockMemento();
    manager = new TabStateManager(memento as any);
  });

  it('starts with empty tabs', () => {
    expect(manager.getTabs()).toEqual([]);
  });

  it('adds a tab', async () => {
    await manager.addTab({ uid: 'abc', name: 'Claude', order: 0 });
    expect(manager.getTabs()).toEqual([{ uid: 'abc', name: 'Claude', order: 0 }]);
  });

  it('removes a tab', async () => {
    await manager.addTab({ uid: 'abc', name: 'Claude', order: 0 });
    await manager.removeTab('abc');
    expect(manager.getTabs()).toEqual([]);
  });

  it('renames a tab', async () => {
    await manager.addTab({ uid: 'abc', name: 'Claude', order: 0 });
    await manager.renameTab('abc', 'Codex');
    expect(manager.getTabs()[0].name).toBe('Codex');
  });

  it('reorders tabs', async () => {
    await manager.addTab({ uid: 'a', name: 'First', order: 0 });
    await manager.addTab({ uid: 'b', name: 'Second', order: 1 });
    await manager.reorderTabs(['b', 'a']);
    const tabs = manager.getTabs();
    expect(tabs[0].uid).toBe('b');
    expect(tabs[0].order).toBe(0);
    expect(tabs[1].uid).toBe('a');
    expect(tabs[1].order).toBe(1);
  });

  it('persists across instances', async () => {
    await manager.addTab({ uid: 'abc', name: 'Claude', order: 0 });
    const manager2 = new TabStateManager(memento as any);
    expect(manager2.getTabs()).toEqual([{ uid: 'abc', name: 'Claude', order: 0 }]);
  });
});
