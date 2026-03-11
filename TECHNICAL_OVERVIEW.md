# Technical Overview

Last updated: 2026-03-11

## What This Is

A real-time web dashboard for [ait](https://github.com/ohnotnow/agent-issue-tracker) — polls the local SQLite database and streams issue state to the browser via SSE.

## Stack

- Bun (runtime, server, bundler)
- TypeScript (strict mode)
- Vanilla HTML/CSS/JS frontend (no framework, no build step)
- IBM Plex Sans + IBM Plex Mono (Google Fonts)

## Files

```
server.ts      ← Bun.serve() entry point: CLI parsing, ait polling, SSE broadcast
index.html     ← Single-page dashboard: all CSS + JS inline
package.json   ← Scripts: dev (--hot), start
```

That's the entire app. Two files.

## Server Architecture (server.ts)

### CLI Arguments

| Flag | Default | Purpose |
|------|---------|---------|
| positional | `./` | Path to the project containing `.ait/ait.db` |
| `--port` | `6174` | Preferred port |
| `--poll` | `3` | Poll interval in seconds |
| `--ait-path` | `ait` | Path to the ait binary |
| `--localhost` | off | Bind to 127.0.0.1 instead of 0.0.0.0 |

### Data Flow

1. `poll()` runs on a timer (default 3s)
2. Shells out to `ait --db <path> list --long --all` and `ait --db <path> status`
3. Hashes the combined output — skips broadcast if unchanged
4. Sends JSON over SSE to all connected clients

### Functions

| Function | Purpose |
|----------|---------|
| `runAit(command[])` | Executes ait CLI via `Bun.$` with the resolved db path |
| `poll()` | Fetches issues + status, hashes, broadcasts if changed |
| `broadcast(data)` | Pushes SSE `data:` frames to all connected controllers |
| `handleSSE()` | Creates a ReadableStream, adds controller to client set |
| `findPort()` | Tries a list of mathematical curiosity ports, then walks upward |
| `fetchConfig()` | One-shot call to `ait config` for the project prefix |

### Routes

| Path | Response |
|------|----------|
| `/` | Serves `index.html` |
| `/events` | SSE stream |
| `*` | 404 |

## Frontend Architecture (index.html)

Everything is in one file — CSS in `<style>`, JS in `<script>`, no imports.

### CSS

- CSS custom properties for all colours (dark theme default, light via `prefers-color-scheme`)
- Five priority colour scales (P0–P4) with foreground + translucent background
- Four status colours (open, in_progress, closed, cancelled)
- Collapsed column styles use `writing-mode: vertical-lr` for sideways headers
- Transitions on opacity, colour, and flex sizing for smooth updates

### JavaScript

`connect()` handles the SSE connection with exponential backoff reconnect (1s to 15s cap).

`render(data)` is the main loop, called on every SSE message:
1. Updates header bar (project name, count pills, timestamp)
2. Groups issues: epics as columns, tasks under their parent epic, orphans in "Standalone"
3. Separates active vs completed epics — completed sort to the right
4. If all epics completed → shows "all clear" state
5. Reconciles DOM in-place (no innerHTML replacement) for CSS transition support

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
