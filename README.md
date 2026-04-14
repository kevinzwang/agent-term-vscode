# Agent Terminal

A VSCode extension that provides a persistent terminal pane for agentic coding workflows. Terminals survive window reloads and VSCode restarts — ideal for long-running AI coding agents like Claude, Codex, or Gemini.

## Features

- **Session persistence** — Terminal sessions keep running in the background when you close or reload VSCode. Reopen the window and your terminals are restored with their output history.
- **Configurable startup command** — Automatically launch `claude`, `codex`, or any command when creating a new terminal tab.
- **Draggable pane** — Place the terminal in the secondary sidebar, bottom panel, or anywhere else in VSCode.
- **Native terminal experience** — Built on xterm.js (same renderer as VSCode's built-in terminal) with matching theme colors, font settings, and scroll behavior.
- **Tab management** — Multiple terminal tabs with rename (Enter key), kill (trash icon on hover), drag-to-reorder, and right-click context menu. Tab sidebar auto-hides with a single tab.
- **Process name tabs** — Tab names automatically update to show the running process (e.g., "zsh", "claude", "node"), just like the built-in terminal.

## How It Works

Instead of tmux, Agent Terminal uses a lightweight background daemon process that holds PTY sessions directly. The daemon communicates with the extension over a Unix domain socket and persists across VSCode restarts. When you reopen a window, the extension reconnects to the daemon and replays buffered output to restore your terminal state.

## Installation

### From source

```bash
git clone https://github.com/kevinzwang/agent-term-vscode.git
cd agent-term-vscode
npm install
npm run build
```

Then press F5 in VSCode to launch the Extension Development Host, or package as a VSIX:

```bash
npx vsce package
code --install-extension agent-terminal-0.1.0.vsix
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTerminal.startupCommand` | `""` | Command to run automatically when creating a new terminal tab (e.g., `"claude"`) |
| `agentTerminal.scrollback` | `5000` | Number of lines to keep in the scrollback buffer |

## Commands

| Command | Description |
|---------|-------------|
| New Agent Terminal | Create a new terminal tab (+ button in title bar) |
| Kill Agent Terminal Tab | Kill the active or right-clicked tab |
| Rename Agent Terminal Tab | Rename a tab (also: select tab and press Enter) |
| Focus Agent Terminal | Focus the Agent Terminal view |

## Requirements

- Node.js (for the background daemon process)
- macOS or Linux

## Architecture

```
VSCode Extension Host          Background Daemon (Node.js)
┌──────────────────────┐       ┌─────────────────────────┐
│  Webview (xterm.js)  │       │  PTY sessions (node-pty) │
│  Tab UI              │◄─────►│  Output ring buffer      │
│  DaemonClient        │ Unix  │  Process name polling    │
│                      │socket │                          │
└──────────────────────┘       └─────────────────────────┘
```

The daemon spawns PTY processes directly via node-pty (no tmux). It stays alive across VSCode restarts via `nohup`/`setsid` detachment and ignores SIGTERM from the dying extension host.

## License

ISC
