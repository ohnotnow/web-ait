# ait-web: Live Dashboard for Agent Issue Tracker

## Context

`ait` is a local-first CLI issue tracker for coding agents. It works well for agents, but developers supervising agent work have no quick visual way to see what's happening — which epics exist, which tasks are in progress, who's claimed what. A lightweight web dashboard that polls `ait` and displays a live epic board would fill that gap.

This is a **separate project** with zero coupling to `ait` internals. It shells out to the `ait` binary and renders what it gets back.

## Core Concept

A single-page web app served by a small Bun server. The server polls `ait` periodically and pushes updates to the browser. The browser displays an epic board with a summary bar. Read-only — no mutations from the UI.

## Tech Stack

- **Runtime**: Bun
- **Server**: Bun's native HTTP server (or Hono if routing gets complex — but probably not needed)
- **Client**: Single HTML file with inline CSS and JS. No framework, no build step.
- **Data**: Server shells out to `ait` CLI commands and caches the JSON
- **Live updates**: Server-Sent Events (SSE) — simpler than WebSockets, perfect for one-way data push

## Architecture

```
Browser (single HTML page)
   ↑ SSE stream (JSON payloads every N seconds)
   |
Bun server (single file: server.ts)
   ↑ spawns `ait` commands on a timer
   |
ait CLI → reads .ait/ait.db
```

### Server responsibilities

1. On startup, resolve the `ait` binary path and the target project directory (configurable via CLI args or env)
2. Run a poll loop (default: every 3 seconds):
   - `ait list --long --all` → full issue list with hierarchy
   - `ait status` → aggregate counts
3. Hold the latest results in memory
4. Serve the HTML page at `/`
5. Serve an SSE endpoint at `/events` that pushes new data whenever the poll detects changes

### Client responsibilities

1. Connect to `/events` SSE stream
2. On each message, parse the JSON and re-render the UI
3. No local state beyond what the server sends

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│  ait-web   project: my-app                          │
│                                                     │
│  Open: 12   In Progress: 3   Closed: 8   Ready: 5  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─ EPIC-1 ─────────────┐  ┌─ EPIC-2 ────────────┐ │
│  │ Auth Flow    P1  ◐    │  │ API Layer   P1  ○   │ │
│  │                       │  │                     │ │
│  │ ✓ Setup OAuth         │  │ ○ Design endpoints  │ │
│  │ ◐ Token refresh       │  │ ○ Rate limiting     │ │
│  │   └ agent-1           │  │                     │ │
│  │ ○ Rate limiting       │  │                     │ │
│  │ ○ Logout flow         │  └─────────────────────┘ │
│  └───────────────────────┘                          │
│                                                     │
│  ┌─ Standalone Tasks ───────────────────────────┐   │
│  │ ○ Fix README typo  P3                        │   │
│  │ ◐ Update deps      P2  └ agent-2             │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Summary bar (top)

- Project name (from `ait config` prefix)
- Counts: open, in_progress, closed, ready — as coloured pills/badges
- Last updated timestamp

### Epic board (main area)

- Each epic rendered as a card
- Cards flow left-to-right, wrapping (CSS flexbox or grid)
- Inside each card:
  - Epic title, priority badge, status indicator
  - Child tasks listed vertically
  - Each task shows: status icon, title, priority (if P0/P1), claimed_by if present
- Status indicators: ○ open, ◐ in_progress, ✓ closed, ✕ cancelled
- Priority shown as small coloured label (P0=red, P1=orange, P2=yellow, P3=blue, P4=grey)

### Standalone tasks

- Tasks with no parent epic grouped in a "Standalone Tasks" card at the bottom
- Same rendering as tasks within epics

### Visual style

- Auto light/dark mode via `prefers-color-scheme`
- Light: white background, subtle card borders, muted colours
- Dark: dark background (#1a1a2e or similar), lighter cards (#16213e), softer text
- Minimal, clean — no gradients, no shadows heavier than a subtle box-shadow
- Monospace font for IDs, proportional for everything else

## Data Flow Detail

### What to fetch

| Command | Purpose | Frequency |
|---------|---------|-----------|
| `ait list --long --all` | All issues with full details | Every poll |
| `ait status` | Aggregate counts for summary bar | Every poll |
| `ait config` | Project prefix (for display) | Once on startup |

### Assembling the board from the data

The `list --long --all` response gives us flat issues with `parent_id` fields. The server (or client) groups them:

1. Separate epics (type=epic) from tasks (type=task)
2. Group tasks by `parent_id` — tasks whose parent_id matches an epic's id are children of that epic
3. Tasks with no parent_id (and no epic parent) go into "Standalone Tasks"
4. Sort epics by priority, then by creation time
5. Sort tasks within each epic by priority, then creation time

### Change detection

To avoid unnecessary SSE pushes, the server can hash the JSON response from `ait` and only push when it changes. This keeps the browser quiet when nothing is happening.

## Configuration

The server should accept configuration via CLI flags:

```bash
ait-web                              # defaults: current dir, auto port, poll 3s
ait-web ./                           # explicit current dir (same as default)
ait-web /path/to/repo                # point at a different project
ait-web --port 6174                  # force a specific port
ait-web --poll 5                     # poll interval in seconds
ait-web --ait-path /usr/local/bin/ait  # custom ait binary path
```

The project path is the **first positional argument**, defaulting to `./` (current directory). Relative paths are resolved to absolute. This means a shell alias like `alias web-ait="ait-web"` lets you just run `web-ait` from any project directory.

### Port selection

Default port is **6174** (Kaprekar's constant — geeky, memorable, unlikely to clash with dev servers).

Since multiple users on a shared server (or one developer with several projects) may run instances simultaneously, the server uses an **auto-port strategy**:

1. Try the preferred port (default 6174, or `--port` value)
2. If busy, walk through a list of geeky fallback ports: `6174, 1729, 2520, 5040, 8128, 6765, 4181`
   - 1729: Hardy-Ramanujan number
   - 2520: smallest number divisible by 1-10
   - 5040: 7! (factorial)
   - 8128: perfect number
   - 6765, 4181: Fibonacci numbers
3. If all fallbacks are taken, increment from the last fallback (+1, +2, ...) until a free port is found
4. Print the chosen port to stdout on startup: `ait-web listening on http://localhost:6174 for /path/to/project`

When `--port` is explicitly set, skip the fallback list and just try that port (fail if busy — the user asked for a specific port, so they should know if it's in use).

## File Structure (the whole project)

```
ait-web/
  package.json          # name, version, bun scripts
  server.ts             # entire server (~100-150 lines)
  index.html            # entire client: HTML + CSS + JS (~300-400 lines)
  README.md
```

That's it. Two functional files.

## Implementation Phases

### Phase 1: Walking skeleton
- Bun server that shells out to `ait list --long --all` and `ait status`
- Serves a static HTML page
- SSE endpoint that pushes data
- Client renders a basic list of epics and tasks (unstyled)
- **Goal**: prove the data flow works end to end

### Phase 2: Epic board layout
- CSS grid/flexbox layout for epic cards
- Summary bar with counts
- Status icons and priority badges
- Group tasks under their parent epics
- Standalone tasks section

### Phase 3: Polish
- Light/dark mode with prefers-color-scheme
- Claimed-by display
- Smooth transitions when data updates (CSS transitions on opacity/colour)
- Reconnect logic for SSE (auto-reconnect on disconnect)
- Responsive layout (cards reflow on narrower screens)

### Phase 4: Nice-to-haves (optional, only if it feels incomplete)
- Click an issue ID to expand and show description + notes
- Filter/search within the board
- Sort toggle (by priority vs. by recent activity)

## Verification

1. Set up a test project with `ait init --prefix test`, create a few epics and tasks
2. Run `bun run server.ts --project /path/to/test/project`
3. Open browser at localhost:3000
4. Verify summary bar shows correct counts
5. Verify epics display as cards with their children
6. Use `ait update` / `ait claim` / `ait close` from the CLI and confirm the board updates within a few seconds
7. Toggle system light/dark mode and confirm the UI follows

## Complexity Assessment

This is a genuinely small project:
- Server: ~100-150 lines of TypeScript
- Client: ~300-400 lines of HTML/CSS/JS
- No dependencies beyond Bun itself (possibly Hono if desired, but not required)
- No build step, no bundler, no framework
- The hardest part is making the CSS look nice, and even that's straightforward with flexbox and CSS custom properties

A coding agent could likely build the walking skeleton in one session and polish it in a second.
