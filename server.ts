import { $ } from "bun";
import { resolve, basename } from "path";
import { homedir } from "os";
import { mkdir } from "node:fs/promises";

// --- Config paths ---
const CONFIG_DIR = resolve(homedir(), ".config", "web-ait");
const PROJECTS_FILE = resolve(CONFIG_DIR, "projects.txt");
const PID_FILE = resolve(CONFIG_DIR, "server.pid");
const TIMER_RESETS_FILE = resolve(CONFIG_DIR, "timer-resets.json");

// --- CLI argument parsing ---
const args = process.argv.slice(2);
const projectPaths: string[] = [];
let preferredPort = 6174;
let portExplicit = false;
let pollInterval = 3;
let aitPath = "ait";
let hostname = "0.0.0.0";
let clientMode = false;
let serverMode = false;
let stopMode = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--port") {
    preferredPort = parseInt(args[++i]!, 10);
    portExplicit = true;
  } else if (arg === "--poll") {
    pollInterval = parseInt(args[++i]!, 10);
  } else if (arg === "--ait-path") {
    aitPath = args[++i]!;
  } else if (arg === "--localhost") {
    hostname = "127.0.0.1";
  } else if (arg === "--client") {
    clientMode = true;
  } else if (arg === "--server") {
    serverMode = true;
  } else if (arg === "--stop") {
    stopMode = true;
  } else if (!arg.startsWith("--")) {
    projectPaths.push(resolve(arg));
  }
}

// --- Registration file helpers ---
async function ensureProjectsDir(): Promise<void> {
  await mkdir(resolve(homedir(), ".config", "web-ait"), { recursive: true });
}

async function readProjectsFile(): Promise<string[]> {
  try {
    const text = await Bun.file(PROJECTS_FILE).text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function writeProjectsFile(paths: string[]): Promise<void> {
  await ensureProjectsDir();
  await Bun.write(PROJECTS_FILE, paths.join("\n") + "\n");
}

async function registerProject(projectPath: string): Promise<void> {
  const absPath = resolve(projectPath);
  const dbFile = Bun.file(resolve(absPath, ".ait", "ait.db"));
  if (!(await dbFile.exists())) {
    console.warn(`Warning: no .ait/ait.db found in ${absPath}`);
  }
  const existing = await readProjectsFile();
  if (existing.includes(absPath)) {
    console.log(`Already registered: ${absPath}`);
    return;
  }
  existing.push(absPath);
  await writeProjectsFile(existing);
  console.log(`Registered: ${absPath}`);
}

async function removeProjectFromFile(projectPath: string): Promise<void> {
  const existing = await readProjectsFile();
  const filtered = existing.filter((p) => p !== projectPath);
  await writeProjectsFile(filtered);
}

// --- PID file helpers ---
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(): Promise<number | null> {
  try {
    const text = await Bun.file(PID_FILE).text();
    const pid = parseInt(text.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function writePidFile(): Promise<void> {
  await ensureProjectsDir();
  await Bun.write(PID_FILE, String(process.pid));
}

async function removePidFile(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(PID_FILE);
  } catch {}
}

// --- Stop mode: kill running server and exit ---
if (stopMode) {
  const pid = await readPidFile();
  if (!pid || !isProcessRunning(pid)) {
    console.log("No running web-ait server found.");
    await removePidFile();
    process.exit(0);
  }
  process.kill(pid, "SIGTERM");
  // Wait briefly for it to exit
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (!isProcessRunning(pid)) { gone = true; break; }
  }
  if (gone) {
    console.log(`Stopped web-ait server (PID ${pid}).`);
    await removePidFile();
  } else {
    console.error(`Failed to stop server (PID ${pid}) — process still running.`);
    process.exit(1);
  }
  process.exit(0);
}

// --- Client mode: register and exit ---
if (clientMode) {
  const path = projectPaths.length > 0 ? projectPaths[0]! : resolve(".");
  await registerProject(path);
  process.exit(0);
}

// --- Server mode: pre-register any path args, then start ---
// (No flags + path args also enters server mode — single code path)
if (projectPaths.length > 0) {
  for (const p of projectPaths) {
    await registerProject(p);
  }
}

// --- Per-project state ---
type ProjectState = {
  id: string;
  name: string;
  projectPath: string;
  dbPath: string;
  cachedData: { issues: unknown; status: unknown; config: unknown } | null;
  lastHash: string;
};

const projects = new Map<string, ProjectState>();
const sseClients = new Set<ReadableStreamDefaultController>();

// --- Activity tracking (drives the activity log + flash highlights) ---
const previousTaskStates = new Map<string, Map<string, { status: string; claimed_by: string | null }>>();
let initialPollDone = false;

// --- Per-project elapsed-timer reset anchors (projectPath -> ISO timestamp) ---
const projectTimerResets = new Map<string, string>();

async function loadTimerResets(): Promise<void> {
  try {
    const raw = await Bun.file(TIMER_RESETS_FILE).text();
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const [path, iso] of Object.entries(data)) {
        if (typeof iso === "string") projectTimerResets.set(path, iso);
      }
    }
  } catch {
    // file doesn't exist yet — that's fine
  }
}

async function saveTimerResets(): Promise<void> {
  await ensureProjectsDir();
  const data = Object.fromEntries(projectTimerResets.entries());
  await Bun.write(TIMER_RESETS_FILE, JSON.stringify(data, null, 2));
}

// --- ait command helpers ---
async function runAit(dbPath: string, command: string[]): Promise<string> {
  return await $`${aitPath} --db ${dbPath} ${command}`.text();
}

async function fetchConfig(dbPath: string): Promise<unknown> {
  try {
    return JSON.parse(await runAit(dbPath, ["config"]));
  } catch {
    return { prefix: "unknown" };
  }
}

// --- Derive a human-friendly name from config or path ---
function projectDisplayName(config: any, projectPath: string): string {
  const prefix = config?.prefix;
  if (prefix && prefix !== "unknown") {
    return prefix.split("/").pop().replace(/[-_]/g, " ");
  }
  return basename(projectPath);
}

// --- Compute project status summary for the sidebar ---
function projectStatus(
  cachedData: ProjectState["cachedData"],
): "active" | "idle" | "done" | "empty" {
  const issues = (cachedData?.issues as any)?.issues;
  if (!issues || issues.length === 0) return "empty";
  const tasks = issues.filter((i: any) => i.type === "task");
  if (tasks.length === 0) return "empty";
  const allDone = tasks.every(
    (t: any) => t.status === "closed" || t.status === "cancelled",
  );
  if (allDone) return "done";
  const hasWip = tasks.some((t: any) => t.status === "in_progress");
  return hasWip ? "active" : "idle";
}

// --- Build the projects list for SSE ---
function buildProjectsList(): {
  id: string;
  name: string;
  status: string;
  path: string;
}[] {
  return Array.from(projects.values()).map((p) => ({
    id: p.projectPath,
    name: p.name,
    status: projectStatus(p.cachedData),
    path: p.projectPath,
  }));
}

// --- SSE broadcasting ---
function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(payload);
    } catch {
      sseClients.delete(controller);
    }
  }
}

// --- Sync projects from registration file ---
async function syncProjectsFromFile(): Promise<boolean> {
  const paths = await readProjectsFile();
  let changed = false;

  // Add new projects
  for (const p of paths) {
    if (!projects.has(p)) {
      const dbPath = resolve(p, ".ait", "ait.db");
      const dbFile = Bun.file(dbPath);
      if (!(await dbFile.exists())) continue;

      const config = await fetchConfig(dbPath);
      projects.set(p, {
        id: p,
        name: projectDisplayName(config, p),
        projectPath: p,
        dbPath,
        cachedData: {
          issues: { issues: [] },
          status: { counts: {} },
          config,
        },
        lastHash: "",
      });
      changed = true;
    }
  }

  // Remove projects no longer in file
  let resetsChanged = false;
  for (const key of projects.keys()) {
    if (!paths.includes(key)) {
      projects.delete(key);
      if (projectTimerResets.delete(key)) resetsChanged = true;
      changed = true;
    }
  }
  if (resetsChanged) await saveTimerResets();

  return changed;
}

// --- Poll a single project ---
async function pollProject(state: ProjectState): Promise<boolean> {
  try {
    const [issuesRaw, statusRaw] = await Promise.all([
      runAit(state.dbPath, ["list", "--long", "--all"]),
      runAit(state.dbPath, ["status"]),
    ]);

    const hash = Bun.hash(issuesRaw + statusRaw).toString();
    if (hash === state.lastHash) return false;
    state.lastHash = hash;

    const config = state.cachedData?.config ?? (await fetchConfig(state.dbPath));
    state.cachedData = {
      issues: JSON.parse(issuesRaw),
      status: JSON.parse(statusRaw),
      config,
    };

    return true;
  } catch (e) {
    console.error(`Poll error for ${state.projectPath}:`, e);
    return false;
  }
}

// --- Detect task changes for activity feed ---
function detectChanges(state: ProjectState): { changedTaskIds: string[]; completedEpicIds: string[] } {
  const issues = (state.cachedData?.issues as any)?.issues || [];
  const oldStates = previousTaskStates.get(state.projectPath) || new Map();
  const newStates = new Map<string, { status: string; claimed_by: string | null }>();
  const changedTaskIds: string[] = [];
  const completedEpicIds: string[] = [];

  for (const issue of issues) {
    if (issue.type !== "task") continue;
    newStates.set(issue.id, { status: issue.status, claimed_by: issue.claimed_by || null });

    if (!initialPollDone) continue;

    const old = oldStates.get(issue.id);
    if (!old) {
      broadcastEvent("activity", {
        projectId: state.projectPath, timestamp: Date.now(),
        title: issue.title, description: "New task created",
        agent: null, type: "new_task",
      });
      changedTaskIds.push(issue.id);
    } else {
      if (old.status !== issue.status) {
        broadcastEvent("activity", {
          projectId: state.projectPath, timestamp: Date.now(),
          title: issue.title, description: `Status → ${issue.status.replace("_", " ")}`,
          agent: issue.claimed_by || null, type: "status_change",
        });
        changedTaskIds.push(issue.id);
      }
      if (!old.claimed_by && issue.claimed_by) {
        broadcastEvent("activity", {
          projectId: state.projectPath, timestamp: Date.now(),
          title: issue.title, description: `Claimed by ${issue.claimed_by}`,
          agent: issue.claimed_by, type: "claimed",
        });
        if (!changedTaskIds.includes(issue.id)) changedTaskIds.push(issue.id);
      }
    }
  }

  // Detect epic completions
  if (initialPollDone) {
    for (const issue of issues) {
      if (issue.type !== "epic") continue;
      const children = issues.filter((i: any) => i.parent_id === issue.id && i.type === "task");
      if (children.length === 0) continue;
      const allDone = children.every((t: any) => t.status === "closed" || t.status === "cancelled");
      if (!allDone) continue;
      // Check if previously NOT all done
      const wasDone = children.every((t: any) => {
        const old = oldStates.get(t.id);
        return old && (old.status === "closed" || old.status === "cancelled");
      });
      if (!wasDone) {
        broadcastEvent("activity", {
          projectId: state.projectPath, timestamp: Date.now(),
          title: issue.title, description: "Epic completed",
          agent: null, type: "epic_complete",
        });
        completedEpicIds.push(issue.id);
      }
    }
  }

  previousTaskStates.set(state.projectPath, newStates);
  return { changedTaskIds, completedEpicIds };
}

// --- Main poll loop ---
async function poll(): Promise<void> {
  const projectListChanged = await syncProjectsFromFile();

  // Poll each project
  let anyDataChanged = false;
  for (const state of projects.values()) {
    const changed = await pollProject(state);
    if (changed) {
      const { changedTaskIds, completedEpicIds } = detectChanges(state);
      broadcastEvent("update", {
        projectId: state.projectPath,
        issues: state.cachedData!.issues,
        status: state.cachedData!.status,
        config: state.cachedData!.config,
        timerResetAt: projectTimerResets.get(state.projectPath) || null,
        changedTaskIds,
        completedEpicIds,
      });
      anyDataChanged = true;
    }
  }

  // If project list changed (or data changed which affects status), broadcast the list
  if (projectListChanged || anyDataChanged) {
    broadcastEvent("projects", buildProjectsList());
  }

  initialPollDone = true;
}

// --- SSE handler ---
function handleSSE(): Response {
  const stream = new ReadableStream({
    start(controller) {
      sseClients.add(controller);
      // Send project list immediately
      const list = buildProjectsList();
      controller.enqueue(
        `event: projects\ndata: ${JSON.stringify(list)}\n\n`,
      );
      // Send cached data for each project
      for (const state of projects.values()) {
        if (state.cachedData) {
          controller.enqueue(
            `event: update\ndata: ${JSON.stringify({
              projectId: state.projectPath,
              issues: state.cachedData.issues,
              status: state.cachedData.status,
              config: state.cachedData.config,
              timerResetAt: projectTimerResets.get(state.projectPath) || null,
            })}\n\n`,
          );
        }
      }
    },
    cancel(controller) {
      sseClients.delete(controller);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// --- Auto-port selection ---
const DEFAULT_PORT = 6174;

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, fetch: () => new Response() });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function findPort(): Promise<number> {
  // If the user explicitly asked for a port, use it as-is
  if (portExplicit) {
    return preferredPort;
  }

  // Check if an existing web-ait server is already running
  const existingPid = await readPidFile();
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(
      `web-ait is already running (PID ${existingPid}) on port ${DEFAULT_PORT}.\n` +
      `  → Use --stop to shut it down, or --port <n> to start a second instance.`
    );
    process.exit(1);
  }

  // Clean up stale PID file if the process is gone
  if (existingPid) {
    await removePidFile();
  }

  if (await isPortFree(DEFAULT_PORT)) return DEFAULT_PORT;

  // Default port is taken by something else — warn rather than silently starting a duplicate
  console.error(
    `Port ${DEFAULT_PORT} is in use (by another application).\n` +
    `  → Use --port <n> to pick a different port.`
  );
  process.exit(1);
}

// --- Start server ---
await loadTimerResets();
const port = await findPort();
await writePidFile();

// Clean up PID file on exit
function cleanup() {
  try { require("node:fs").unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      return handleSSE();
    }

    if (url.pathname === "/api/projects" && req.method === "DELETE") {
      const path = url.searchParams.get("path");
      if (path && projects.has(path)) {
        projects.delete(path);
        await removeProjectFromFile(path);
        if (projectTimerResets.delete(path)) await saveTimerResets();
        broadcastEvent("removed", { projectId: path });
        broadcastEvent("projects", buildProjectsList());
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/projects/timer/reset" && req.method === "POST") {
      const path = url.searchParams.get("path");
      const state = path ? projects.get(path) : null;
      if (!state) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const now = new Date().toISOString();
      projectTimerResets.set(state.projectPath, now);
      await saveTimerResets();
      // Re-broadcast the cached data so every connected client sees the new anchor immediately.
      if (state.cachedData) {
        broadcastEvent("update", {
          projectId: state.projectPath,
          issues: state.cachedData.issues,
          status: state.cachedData.status,
          config: state.cachedData.config,
          timerResetAt: now,
        });
      }
      return new Response(JSON.stringify({ ok: true, timerResetAt: now }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/") {
      return new Response(Bun.file(resolve(import.meta.dir, "index.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

// Initial sync and poll (seed previous states without activity events)
await syncProjectsFromFile();
for (const state of projects.values()) {
  await pollProject(state);
  detectChanges(state);
}
initialPollDone = true;

// Poll loop
setInterval(poll, pollInterval * 1000);

const projectCount = projects.size;
console.log(`ait-web listening on http://${hostname}:${port}`);
if (projectCount > 0) {
  for (const state of projects.values()) {
    console.log(`  → ${state.projectPath}`);
  }
} else {
  console.log(`  Waiting for projects (run with --client to register)`);
}
