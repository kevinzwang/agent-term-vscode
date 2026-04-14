import './styles.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type {
  TabInfo,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../types';

const vscode = acquireVsCodeApi();

// State
const terminals = new Map<string, { term: Terminal; fit: FitAddon; container: HTMLElement }>();
let activeUid: string | null = null;
let tabs: TabInfo[] = [];
let currentFontFamily = 'monospace';
let currentFontSize = 13;
let currentScrollback = 5000;

// Buffer for data that arrives before the terminal is created (e.g., replay on reconnect)
const pendingData = new Map<string, string[]>();

// DOM refs
const tabList = document.getElementById('tab-list')!;
const terminalArea = document.getElementById('terminal-area')!;
const tabSidebar = document.getElementById('tab-sidebar')!;
const resizeHandle = document.getElementById('tab-sidebar-resize')!;

// ---- Theme from CSS variables ----
// VSCode injects theme colors as inline style properties on documentElement.
// Must use .style.getPropertyValue (not getComputedStyle) to read them.

function getVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name).trim();
}

function getFirstVar(...names: string[]): string {
  for (const n of names) {
    const v = getVar(n);
    if (v && v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)') return v;
  }
  return '';
}

function updateActiveBorderColor(): void {
  const color = getFirstVar(
    '--vscode-terminal-tab-activeBorder',
    '--vscode-panelTitle-activeBorder',
    '--vscode-focusBorder',
  );
  document.documentElement.style.setProperty('--agentterm-tab-active-border', color || '#ffffff');
}

function getThemeFromCssVars(): Record<string, string> {
  updateActiveBorderColor();
  const get = getVar;
  return {
    background: getFirstVar('--vscode-terminal-background', '--vscode-sideBar-background', '--vscode-panel-background', '--vscode-editor-background'),
    foreground: get('--vscode-terminal-foreground') || get('--vscode-editor-foreground'),
    cursor: get('--vscode-terminalCursor-foreground'),
    selectionBackground: get('--vscode-terminal-selectionBackground'),
    black: get('--vscode-terminal-ansiBlack'),
    red: get('--vscode-terminal-ansiRed'),
    green: get('--vscode-terminal-ansiGreen'),
    yellow: get('--vscode-terminal-ansiYellow'),
    blue: get('--vscode-terminal-ansiBlue'),
    magenta: get('--vscode-terminal-ansiMagenta'),
    cyan: get('--vscode-terminal-ansiCyan'),
    white: get('--vscode-terminal-ansiWhite'),
    brightBlack: get('--vscode-terminal-ansiBrightBlack'),
    brightRed: get('--vscode-terminal-ansiBrightRed'),
    brightGreen: get('--vscode-terminal-ansiBrightGreen'),
    brightYellow: get('--vscode-terminal-ansiBrightYellow'),
    brightBlue: get('--vscode-terminal-ansiBrightBlue'),
    brightMagenta: get('--vscode-terminal-ansiBrightMagenta'),
    brightCyan: get('--vscode-terminal-ansiBrightCyan'),
    brightWhite: get('--vscode-terminal-ansiBrightWhite'),
  };
}

// ---- Terminal management ----

function createTerminal(uid: string): void {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.dataset.uid = uid;
  terminalArea.appendChild(container);

  const cssTheme = getThemeFromCssVars();

  const openLink = (event: MouseEvent, uri: string) => {
    if (event.metaKey || event.ctrlKey) {
      post({ type: 'open-link', uri });
    }
  };

  const term = new Terminal({
    allowProposedApi: true,
    scrollback: currentScrollback,
    fontSize: currentFontSize,
    fontFamily: currentFontFamily,
    theme: cssTheme,
    // Handle OSC 8 hyperlink clicks
    linkHandler: {
      activate: openLink,
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  // Handle plain-text URL clicks
  term.loadAddon(new WebLinksAddon(openLink));
  term.open(container);

  fit.fit();

  term.onData((data) => {
    post({ type: 'terminal-input', uid, data });
  });

  // Report initial size
  post({ type: 'resize', uid, cols: term.cols, rows: term.rows });

  terminals.set(uid, { term, fit, container });

  // Flush any data that arrived before the terminal was created
  const buffered = pendingData.get(uid);
  if (buffered) {
    for (const chunk of buffered) {
      term.write(chunk);
    }
    pendingData.delete(uid);
  }
}

function activateTerminal(uid: string): void {
  for (const [id, entry] of terminals) {
    entry.container.classList.toggle('active', id === uid);
  }
  activeUid = uid;

  const entry = terminals.get(uid);
  if (entry) {
    // Use requestAnimationFrame to ensure the container is visible before fitting
    requestAnimationFrame(() => {
      entry.fit.fit();
      post({
        type: 'resize',
        uid,
        cols: entry.term.cols,
        rows: entry.term.rows,
      });
    });
  }

  renderTabs();
}

function removeTerminal(uid: string): void {
  const entry = terminals.get(uid);
  if (entry) {
    entry.term.dispose();
    entry.container.remove();
    terminals.delete(uid);
  }
  pendingData.delete(uid);
}

// ---- Tab rendering ----

// ---- Mouse-based drag reorder (HTML5 drag doesn't work in webview iframes) ----

let dragState: { uid: string; el: HTMLElement; startY: number } | null = null;

function handleDragMove(e: MouseEvent): void {
  if (!dragState) return;
  e.preventDefault();
  clearDropIndicators();

  // Find which tab we're over
  const items = tabList.querySelectorAll('.tab-item');
  for (const item of items) {
    if ((item as HTMLElement).dataset.uid === dragState.uid) continue;
    const rect = item.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        item.classList.add('drag-over-top');
      } else {
        item.classList.add('drag-over-bottom');
      }
      break;
    }
  }
}

function handleDragEnd(e: MouseEvent): void {
  if (!dragState) return;
  document.removeEventListener('mousemove', handleDragMove);
  document.removeEventListener('mouseup', handleDragEnd);

  dragState.el.classList.remove('dragging');

  // Find drop target
  const overEl = tabList.querySelector('.drag-over-top, .drag-over-bottom') as HTMLElement;
  if (overEl) {
    const targetUid = overEl.dataset.uid!;
    const insertBefore = overEl.classList.contains('drag-over-top');

    const uids = tabs.map((t) => t.uid).filter((u) => u !== dragState!.uid);
    const targetIdx = uids.indexOf(targetUid);
    const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
    uids.splice(insertIdx, 0, dragState!.uid);

    post({ type: 'tab-reordered', uids });
  }

  clearDropIndicators();
  dragState = null;
}

function renderTabs(): void {
  // Hide sidebar when there's only one tab (like built-in terminal)
  tabSidebar.classList.toggle('hidden', tabs.length <= 1);

  tabList.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.uid === activeUid ? ' active' : '');
    el.dataset.uid = tab.uid;
    el.tabIndex = 0;

    const icon = document.createElement('span');
    icon.className = 'tab-icon codicon codicon-terminal';

    const name = document.createElement('div');
    name.className = 'tab-name';
    name.textContent = tab.name;

    const killBtn = document.createElement('button');
    killBtn.className = 'tab-kill codicon codicon-trash';
    killBtn.title = 'Kill Terminal';
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'tab-killed', uid: tab.uid });
    });

    el.appendChild(icon);
    el.appendChild(name);
    el.appendChild(killBtn);

    // Click to select + start drag after threshold
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.tab-kill')) return;
      e.preventDefault();
      el.focus();

      if (tab.uid !== activeUid) {
        post({ type: 'tab-selected', uid: tab.uid });
      }

      // Start tracking for drag
      const startY = e.clientY;
      const onMove = (me: MouseEvent) => {
        if (!dragState && Math.abs(me.clientY - startY) > 5) {
          // Exceeded threshold — start drag
          dragState = { uid: tab.uid, el, startY };
          el.classList.add('dragging');
          document.addEventListener('mousemove', handleDragMove);
          document.addEventListener('mouseup', handleDragEnd);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Enter to rename
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startInlineRename(tab.uid);
      }
    });

    // Right-click context menu
    el.addEventListener('contextmenu', () => {
      post({ type: 'tab-context-click', uid: tab.uid });
    });

    tabList.appendChild(el);
  }
}

function clearDropIndicators(): void {
  tabList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((el) => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
}


// ---- Inline rename ----

function startInlineRename(uid: string): void {
  const tabEl = tabList.querySelector(`.tab-item[data-uid="${uid}"]`) as HTMLElement;
  if (!tabEl) return;

  const nameEl = tabEl.querySelector('.tab-name') as HTMLElement;
  if (!nameEl) return;

  const currentName = nameEl.textContent ?? '';

  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.type = 'text';
  input.value = currentName;

  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = (commit: boolean) => {
    const newName = input.value.trim();
    const restored = document.createElement('div');
    restored.className = 'tab-name';
    restored.textContent = commit && newName ? newName : currentName;
    input.replaceWith(restored);

    if (commit && newName && newName !== currentName) {
      post({ type: 'tab-renamed', uid, name: newName });
    }
  };

  input.addEventListener('blur', () => finish(true), { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
}

// ---- Resize handling ----

const resizeObserver = new ResizeObserver(() => {
  if (activeUid) {
    const entry = terminals.get(activeUid);
    if (entry) {
      entry.fit.fit();
      post({
        type: 'resize',
        uid: activeUid,
        cols: entry.term.cols,
        rows: entry.term.rows,
      });
    }
  }
});

resizeObserver.observe(terminalArea);

// ---- Message handling ----

function post(msg: WebviewToExtensionMessage): void {
  vscode.postMessage(msg);
}

window.addEventListener('message', (event) => {
  const msg = event.data as ExtensionToWebviewMessage;

  switch (msg.type) {
    case 'terminal-data': {
      const entry = terminals.get(msg.uid);
      if (entry) {
        entry.term.write(msg.data);
      } else {
        // Terminal not created yet — buffer for later (happens during replay on reconnect)
        let buf = pendingData.get(msg.uid);
        if (!buf) {
          buf = [];
          pendingData.set(msg.uid, buf);
        }
        buf.push(msg.data);
      }
      break;
    }

    case 'tabs-updated': {
      tabs = msg.tabs;
      const activeTab = msg.activeUid;

      // Create terminals for new tabs
      for (const tab of tabs) {
        if (!terminals.has(tab.uid)) {
          createTerminal(tab.uid);
        }
      }
      // Remove terminals for deleted tabs
      for (const uid of terminals.keys()) {
        if (!tabs.find((t) => t.uid === uid)) {
          removeTerminal(uid);
        }
      }

      if (activeTab) {
        activateTerminal(activeTab);
      }
      renderTabs();
      break;
    }

    case 'session-ended': {
      const entry = terminals.get(msg.uid);
      if (entry) {
        const overlay = document.createElement('div');
        overlay.className = 'session-ended';
        overlay.innerHTML = `<p>Session ended</p>`;
        const btn = document.createElement('button');
        btn.textContent = 'Restart';
        btn.addEventListener('click', () => {
          overlay.remove();
          post({ type: 'tab-restart', uid: msg.uid });
        });
        overlay.appendChild(btn);
        entry.container.appendChild(overlay);
      }
      break;
    }

    case 'theme-changed': {
      const updatedTheme = getThemeFromCssVars();
      currentFontSize = msg.theme.fontSize;
      currentFontFamily = msg.theme.fontFamily;
      for (const [, entry] of terminals) {
        entry.term.options.theme = updatedTheme;
        entry.term.options.fontSize = currentFontSize;
        entry.term.options.fontFamily = currentFontFamily;
        entry.fit.fit();
      }
      break;
    }

    case 'config-updated': {
      currentScrollback = msg.scrollback;
      break;
    }

    case 'start-rename': {
      startInlineRename(msg.uid);
      break;
    }

  }
});

// ---- Sidebar resize ----

let resizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
});

document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const newWidth = Math.min(Math.max(e.clientX, 46), 500);
  tabSidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  // Refit active terminal after sidebar resize
  if (activeUid) {
    const entry = terminals.get(activeUid);
    if (entry) {
      entry.fit.fit();
      post({
        type: 'resize',
        uid: activeUid,
        cols: entry.term.cols,
        rows: entry.term.rows,
      });
    }
  }
});

// Initial theme setup
updateActiveBorderColor();

// Signal ready
post({ type: 'ready' });
