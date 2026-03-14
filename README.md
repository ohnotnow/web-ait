# web-ait

A web dashboard for [ait](https://github.com/ohnotnow/ait) (Agent Issue Tracker). It polls your local ait database and streams updates to the browser via Server-Sent Events so you can see what your coding agents are up to.

Monitor multiple projects from a single dashboard — start the server once, then register projects as you begin working on them.

![Screenshot](screenshot.png)

## What it does

- Displays epics as columns with their child tasks listed vertically
- Shows status icons, priority badges, and which agent has claimed each task
- Completed epics collapse to narrow strips and slide to the right, keeping active work front and centre
- When everything is done, a calm "all clear" state replaces the board
- **Multi-project sidebar** with per-project status indicators (active / idle / done)
- Auto light/dark mode based on your system preference
- Auto-reconnects if the SSE connection drops

## Prerequisites

- [Bun](https://bun.sh/) (v1.0+)
- [ait](https://github.com/ohnotnow/agent-issue-tracker) installed and available on your PATH

## Quick start

```bash
bun install
bun run dev
```

This starts the server with hot-reload on `http://localhost:6174` (or the next free port).

## Usage

### Single project

Point it at any directory containing an `.ait/ait.db` database:

```bash
bun run server.ts /path/to/your/project
```

This registers the project and starts the server in one step.

### Multiple projects

Start the server in one terminal:

```bash
bun run server.ts --server
```

Then from each project directory you're working in:

```bash
cd /path/to/project-a
bun run server.ts --client

cd /path/to/project-b
bun run server.ts --client
```

Projects appear in the dashboard sidebar within a few seconds. Click the project name in the header to open the sidebar and switch between projects. Each project shows a status dot: pulsing amber for active (has work in progress), grey for idle, green for done.

You can also pre-register multiple projects and start the server in one go:

```bash
bun run server.ts /path/to/project-a /path/to/project-b
```

### How it works

Projects are tracked in `~/.config/web-ait/projects.txt` — one path per line. The `--client` flag appends to this file; the server polls it for changes. You can edit the file directly if you prefer.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | — | Start in server mode (reads projects from registration file) |
| `--client` | — | Register current directory as a project and exit |
| `--port <n>` | `6174` | Preferred port (auto-finds a free one if not specified) |
| `--poll <n>` | `3` | Poll interval in seconds |
| `--ait-path <path>` | `ait` | Path to the ait binary |
| `--localhost` | off | Bind to 127.0.0.1 only (default is 0.0.0.0 for LAN access) |

### Shell aliases

Add these to your `~/.bashrc` or `~/.zshrc`:

```bash
# Start the dashboard server
alias webait-server='bun run /path/to/web-ait/server.ts --server'

# Register the current project directory
alias webait='bun run /path/to/web-ait/server.ts --client'
```

Workflow: run `webait-server` once, then `cd` into any project and run `webait` to add it to the dashboard.

### Demo Mode

If you want a rather flashier, noiser dashboard (which gives a little more impractical but 'wow' feel), append `?demo` to the url.  The visuals should still work ok over a video call - it's not _too_ out there...

## Licence

[MIT](LICENSE)
