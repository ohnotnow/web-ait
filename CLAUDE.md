---
description: Project conventions and architecture for web-ait
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: true
---

# web-ait

Real-time web dashboard for [ait](https://github.com/ohnotnow/agent-issue-tracker). Polls local SQLite databases via the `ait` CLI and streams updates to the browser over SSE.

## Architecture

Two files:

- `server.ts` — Bun.serve() entry point: CLI modes, multi-project polling, SSE broadcast
- `index.html` — Single-page dashboard: all CSS + JS inline, no framework

## Bun

Use Bun for everything. No Node.js, no npm/yarn/pnpm, no vite, no express.

- `bun run dev` — starts with --hot for live reload
- `bun test` — run tests (import from `bun:test`)
- `Bun.serve()` for HTTP/WebSocket/SSE
- `bun:sqlite` for SQLite (not better-sqlite3)
- `Bun.file` over node:fs readFile/writeFile
- `Bun.$` for shell commands (not execa)
- Bun auto-loads .env — no dotenv

## Server (server.ts)

Three CLI modes:
- `--server` (or pass path args): start dashboard, poll projects
- `--client`: register current directory and exit
- `--stop`: graceful shutdown via PID file

Key flags: `--port` (default 6174), `--poll` (default 3s), `--ait-path`, `--localhost`

Data flow: poll timer -> read registration file (`~/.config/web-ait/projects.txt`) -> shell out to `ait --db <path> list --long --all` and `ait --db <path> status` per project -> hash output -> broadcast via SSE if changed.

SSE named events: `projects` (list + statuses), `update` (single project data), `removed`.

Routes: `/` (index.html), `/events` (SSE), `/api/projects` (DELETE to remove).

Projects stored in `Map<string, ProjectState>` keyed by absolute path. PID file at `~/.config/web-ait/server.pid`.

## Frontend (index.html)

All inline — CSS custom properties for colours, dark theme default, light via prefers-color-scheme.

JS data layer:
- `projectsData` (Map: path -> {issues, status, config})
- `projectsList` (array from server)
- `activeProjectId` (current view)

Render pipeline: groups issues into epic columns, sorts completed to right, reconciles DOM in place (no innerHTML wipe) so CSS transitions work. Columns can be active, collapsed, or pinned.

SSE reconnects with exponential backoff (1s, capped at 15s).

`?demo` query param enables a flashier UI mode.
