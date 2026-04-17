# Technical Overview

Last updated: 2026-03-14

## What This Is

A real-time web dashboard for [ait](https://github.com/ohnotnow/agent-issue-tracker). Polls local SQLite databases and streams issue state to the browser via SSE. Monitors multiple projects from one dashboard.

## Stack

- Bun (runtime, server, bundler)
- TypeScript (strict mode)
- Vanilla HTML/CSS/JS frontend (no framework, no build step)
- IBM Plex Sans + IBM Plex Mono (Google Fonts)

## Files

```
server.ts      ← Bun.serve() entry point: CLI modes, multi-project polling, SSE broadcast
index.html     ← Single-page dashboard: all CSS + JS inline
package.json   ← Scripts: dev (--hot), start
```

That's the entire app. Two files.

## Server Architecture (server.ts)

### CLI Modes

Three modes:

- `--server` (or pass path args): starts the dashboard, polls the registration file and all registered projects
- `--client`: registers the current directory to the projects file and exits
- `--stop`: reads the PID file, sends SIGTERM to the running server, waits for exit, cleans up

Path arguments (e.g. `bun run server.ts /path/a /path/b`) pre-register those paths then start the server. Everything goes through the registration file.

### CLI Arguments

| Flag | Default | Purpose |
|------|---------|---------|
| positional paths | — | Pre-register these projects, then start server |
| `--server` | — | Start in server mode (reads from registration file) |
| `--client` | — | Register current directory and exit |
| `--stop` | — | Stop the running server |
| `--port` | `6174` | Preferred port |
| `--poll` | `3` | Poll interval in seconds |
| `--ait-path` | `ait` | Path to the ait binary |
| `--localhost` | off | Bind to 127.0.0.1 instead of 0.0.0.0 |

### PID File and Duplicate Prevention

On startup the server writes its PID to `~/.config/web-ait/server.pid` and removes it on clean shutdown (SIGINT/SIGTERM). If the PID file already exists and the process is alive, startup aborts. Stale PID files get cleaned up automatically.

If port 6174 is already taken, the server exits rather than trying fallback ports. `--port <n>` bypasses this check.

### Registration File

`~/.config/web-ait/projects.txt` holds one absolute path per line. The server re-reads it every poll cycle, so new projects appear and removed ones disappear without a restart. `--client` appends to this file. You can also just edit it by hand.

### Per-Project State

Each project carries its own state:

```ts
type ProjectState = {
  id: string;           // absolute path (used as unique key)
  name: string;         // from ait config prefix, or directory basename
  projectPath: string;
  dbPath: string;
  cachedData: { issues; status; config } | null;
  lastHash: string;     // change detection per project
}
```

All projects are stored in a `Map<string, ProjectState>` keyed by absolute path.

### Data Flow

1. `poll()` runs on a timer (default 3s)
2. Reads the registration file, syncs the project map (adds new, removes stale)
3. For each project, shells out to `ait --db <path> list --long --all` and `ait --db <path> status`
4. Hashes the combined output per project — skips broadcast if unchanged
5. Sends named SSE events to all connected clients

### SSE Protocol

Named SSE events (not plain `data:` messages):

| Event | Payload | When |
|-------|---------|------|
| `projects` | `[{id, name, status, path}, ...]` | On connect and whenever the project list or any project's status changes |
| `update` | `{projectId, issues, status, config, timerResetAt}` | When a specific project's data changes (or the elapsed timer is reset). `timerResetAt` is null until the user clicks the badge to reset. |
| `removed` | `{projectId}` | When a project is removed via the API |

On first connect the server sends the `projects` list, then an `update` for each project that has cached data.

### Functions

| Function | Purpose |
|----------|---------|
| `registerProject(path)` | Appends a path to the projects file (deduplicates) |
| `removeProjectFromFile(path)` | Removes a path from the projects file |
| `readProjectsFile()` | Reads and parses the registration file |
| `syncProjectsFromFile()` | Syncs in-memory project map with the file |
| `isProcessRunning(pid)` | Checks if a process is alive via signal 0 |
| `readPidFile()` | Reads the PID from `server.pid` |
| `writePidFile()` | Writes current PID to `server.pid` |
| `removePidFile()` | Deletes the PID file |
| `runAit(dbPath, command[])` | Executes ait CLI via `Bun.$` with a given db path |
| `pollProject(state)` | Fetches issues + status for one project, broadcasts if changed |
| `poll()` | Syncs project list, then polls each project |
| `broadcastEvent(event, data)` | Pushes named SSE events to all connected controllers |
| `handleSSE()` | Creates a ReadableStream, sends initial state |
| `projectStatus(data)` | Computes summary status: active / idle / done / empty |
| `projectDisplayName(config, path)` | Derives human-friendly name from config or path |
| `findPort()` | Returns default port if free, exits with error if taken |

### Routes

| Path | Method | Response |
|------|--------|----------|
| `/` | GET | Serves `index.html` |
| `/events` | GET | SSE stream (named events) |
| `/api/projects` | DELETE | Removes a project (query param: `path`) |
| `/api/projects/timer/reset` | POST | Rebases the elapsed-timer anchor for a project to now (query param: `path`). Persisted to `~/.config/web-ait/timer-resets.json`. |
| `*` | — | 404 |

## Frontend Architecture (index.html)

One file. CSS in `<style>`, JS in `<script>`, no imports.

### CSS

- Custom properties for all colours. Dark theme by default, light via `prefers-color-scheme`.
- Priority colour scales (P0-P4): foreground + translucent background
- Status colours: open, in_progress, closed, cancelled
- Collapsed columns use `writing-mode: vertical-lr` for sideways headers
- Transitions on opacity, colour, and flex sizing
- Sidebar: overlay slide-in, status dots with pulse animation

### JavaScript

#### Multi-Project Data Layer

```js
projectsData    // Map: projectPath -> { issues, status, config }
projectsList    // Array: [{id, name, status, path}, ...] from server
activeProjectId // Currently viewed project path
```

Pinned columns are per-project (`pinnedColumnsPerProject`, a Map of Sets). Focus mode is global.

#### SSE Connection

`connect()` uses named event listeners rather than `onmessage`:

- `projects`: updates sidebar, auto-selects first project
- `update`: stores data, re-renders if it's the active project, updates sidebar status
- `removed`: cleans up state, switches project if needed

Reconnects with exponential backoff (1s, capped at 15s).

#### Sidebar

Click the project name in the header to toggle. Lists all registered projects with a status dot (pulsing amber for active, grey for idle, green for done), the name, and a remove button (`DELETE /api/projects`).

The chevron only shows when there are multiple projects. When all tasks in a project are done, an "all clear" view offers a "switch project" button so you're not stuck.

#### Render Pipeline

`render(data)` takes the active project's data and:
1. Updates the header (project name, count pills, timestamp)
2. Groups issues into columns: epics become columns, tasks sit under their parent, orphans go in "Standalone"
3. Sorts completed epics to the right
4. Shows an "all clear" state if everything is done
5. Reconciles the DOM in place (no `innerHTML` wipe) so CSS transitions work

Switching projects clears the board and re-renders from cache.

Column states: active (full-width, task list visible), collapsed (48px vertical strip, expands on hover), or pinned (user clicked a collapsed column to keep it open).

Columns and tasks are matched by `data-id` / `data-task-id`, updated in place, reordered if needed, removed if stale. No layout thrash.

## Ports

Default port is 6174 (Kaprekar's constant, no particular reason). If it's taken and you didn't pass `--port`, the server exits rather than guessing at another port.

## Local Development

```bash
bun install
bun run dev          # starts with --hot for live reload
```

No tests yet.
