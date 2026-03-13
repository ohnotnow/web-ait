# Technical Overview

Last updated: 2026-03-13

## What This Is

A real-time web dashboard for [ait](https://github.com/ohnotnow/agent-issue-tracker) — polls local SQLite databases and streams issue state to the browser via SSE. Supports monitoring multiple projects from a single dashboard instance.

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

The server has two modes of operation, both using the same code path:

- **Server mode** (`--server` or path args): starts the dashboard, polls the registration file and all registered projects
- **Client mode** (`--client`): registers the current directory to the projects file and exits

Path arguments (e.g. `bun run server.ts /path/a /path/b`) pre-register those paths to the projects file then start the server. There is no separate legacy code path — everything funnels through the registration file.

### CLI Arguments

| Flag | Default | Purpose |
|------|---------|---------|
| positional paths | — | Pre-register these projects, then start server |
| `--server` | — | Start in server mode (reads from registration file) |
| `--client` | — | Register current directory and exit |
| `--port` | `6174` | Preferred port |
| `--poll` | `3` | Poll interval in seconds |
| `--ait-path` | `ait` | Path to the ait binary |
| `--localhost` | off | Bind to 127.0.0.1 instead of 0.0.0.0 |

### Registration File

Projects are tracked in `~/.config/web-ait/projects.txt` — one absolute path per line. The server reads this file on every poll cycle to discover new projects or detect removed ones. The `--client` flag appends to this file. Users can also edit it directly.

### Per-Project State

Each registered project has its own state:

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

The server uses named SSE events (not plain `data:` messages):

| Event | Payload | When |
|-------|---------|------|
| `projects` | `[{id, name, status, path}, ...]` | On connect and whenever the project list or any project's status changes |
| `update` | `{projectId, issues, status, config}` | When a specific project's data changes |
| `removed` | `{projectId}` | When a project is removed via the API |

On initial SSE connect, the server sends the `projects` list followed by an `update` for each project with cached data.

### Functions

| Function | Purpose |
|----------|---------|
| `registerProject(path)` | Appends a path to the projects file (deduplicates) |
| `removeProjectFromFile(path)` | Removes a path from the projects file |
| `readProjectsFile()` | Reads and parses the registration file |
| `syncProjectsFromFile()` | Syncs in-memory project map with the file |
| `runAit(dbPath, command[])` | Executes ait CLI via `Bun.$` with a given db path |
| `pollProject(state)` | Fetches issues + status for one project, broadcasts if changed |
| `poll()` | Syncs project list, then polls each project |
| `broadcastEvent(event, data)` | Pushes named SSE events to all connected controllers |
| `handleSSE()` | Creates a ReadableStream, sends initial state |
| `projectStatus(data)` | Computes summary status: active / idle / done / empty |
| `projectDisplayName(config, path)` | Derives human-friendly name from config or path |
| `findPort()` | Tries a list of mathematical curiosity ports, then walks upward |

### Routes

| Path | Method | Response |
|------|--------|----------|
| `/` | GET | Serves `index.html` |
| `/events` | GET | SSE stream (named events) |
| `/api/projects` | DELETE | Removes a project (query param: `path`) |
| `*` | — | 404 |

## Frontend Architecture (index.html)

Everything is in one file — CSS in `<style>`, JS in `<script>`, no imports.

### CSS

- CSS custom properties for all colours (dark theme default, light via `prefers-color-scheme`)
- Five priority colour scales (P0-P4) with foreground + translucent background
- Four status colours (open, in_progress, closed, cancelled)
- Collapsed column styles use `writing-mode: vertical-lr` for sideways headers
- Transitions on opacity, colour, and flex sizing for smooth updates
- Sidebar styles: overlay, slide-in panel, status dots with pulse animation

### JavaScript

#### Multi-Project Data Layer

```js
projectsData    // Map: projectPath -> { issues, status, config }
projectsList    // Array: [{id, name, status, path}, ...] from server
activeProjectId // Currently viewed project path
```

Pinned columns are scoped per project via `pinnedColumnsPerProject` (Map of Sets). Focus mode is global.

#### SSE Connection

`connect()` uses named event listeners instead of `onmessage`:

- `projects` event: updates the sidebar project list, auto-selects first project
- `update` event: stores data, re-renders if active project, updates sidebar status
- `removed` event: cleans up state, switches to another project if needed

Reconnect uses exponential backoff (1s to 15s cap).

#### Sidebar

Toggled by clicking the project name tile in the header. Shows all registered projects with:

- Status dot: pulsing amber (active/WIP), grey (idle), green (done)
- Project name
- Remove button (calls `DELETE /api/projects`)

The chevron affordance on the project tile only appears when multiple projects are registered.

An "all clear" view includes a "switch project" button so users aren't trapped when all tasks in the current project are complete.

#### Render Pipeline

`render(data)` is called with the active project's data:
1. Updates header bar (project name, count pills, timestamp)
2. Groups issues: epics as columns, tasks under their parent epic, orphans in "Standalone"
3. Separates active vs completed epics — completed sort to the right
4. If all epics completed -> shows "all clear" state
5. Reconciles DOM in-place (no innerHTML replacement) for CSS transition support

Switching projects clears the board and calls `render()` with the new project's cached data.

Column states:
- Active: full-width with task list visible
- Collapsed (completed): 48px vertical strip, expands on hover
- Pinned: user clicked a collapsed column to keep it expanded

DOM reconciliation: columns and tasks are matched by `data-id` / `data-task-id`, updated in place, reordered if needed, and removed if stale. This avoids layout thrash and lets CSS transitions work.

## Ports

The fallback port list: 6174 (Kaprekar), 1729 (Hardy-Ramanujan), 2520 (smallest number divisible by 1-10), 5040 (7!), 8128 (perfect number), 6765 (Fibonacci), 4181 (Fibonacci).

## Local Development

```bash
bun install
bun run dev          # starts with --hot for live reload
```

No tests yet.
