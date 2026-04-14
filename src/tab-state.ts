import type { Memento } from 'vscode';
import type { TabInfo } from './types';

const STATE_KEY = 'agentTerminal.tabs';

export class TabStateManager {
  private tabs: TabInfo[];

  constructor(private readonly state: Memento) {
    this.tabs = this.state.get<TabInfo[]>(STATE_KEY, []);
  }

  getTabs(): TabInfo[] {
    return [...this.tabs];
  }

  async addTab(tab: TabInfo): Promise<void> {
    this.tabs.push(tab);
    await this.persist();
  }

  async removeTab(uid: string): Promise<void> {
    this.tabs = this.tabs.filter((t) => t.uid !== uid);
    this.reindex();
    await this.persist();
  }

  async renameTab(uid: string, name: string, userRenamed?: boolean): Promise<void> {
    const tab = this.tabs.find((t) => t.uid === uid);
    if (tab) {
      tab.name = name;
      if (userRenamed !== undefined) {
        tab.userRenamed = userRenamed;
      }
      await this.persist();
    }
  }

  async reorderTabs(uids: string[]): Promise<void> {
    const byUid = new Map(this.tabs.map((t) => [t.uid, t]));
    this.tabs = uids
      .map((uid) => byUid.get(uid))
      .filter((t): t is TabInfo => t !== undefined);
    this.reindex();
    await this.persist();
  }

  private reindex(): void {
    this.tabs.forEach((t, i) => (t.order = i));
  }

  private async persist(): Promise<void> {
    await this.state.update(STATE_KEY, this.tabs);
  }
}
