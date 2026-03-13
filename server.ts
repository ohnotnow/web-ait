import { $ } from "bun";
import { resolve, basename } from "path";
import { homedir } from "os";
import { mkdir } from "node:fs/promises";

// --- Registration file path ---
const PROJECTS_FILE = resolve(homedir(), ".config", "web-ait", "projects.txt");

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
  for (const key of projects.keys()) {
    if (!paths.includes(key)) {
      projects.delete(key);
      changed = true;
    }
  }

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

// --- Main poll loop ---
async function poll(): Promise<void> {
  const projectListChanged = await syncProjectsFromFile();

  // Poll each project
  let anyDataChanged = false;
  for (const state of projects.values()) {
    const changed = await pollProject(state);
    if (changed) {
      broadcastEvent("update", {
        projectId: state.projectPath,
        issues: state.cachedData!.issues,
        status: state.cachedData!.status,
        config: state.cachedData!.config,
      });
      anyDataChanged = true;
    }
  }

  // If project list changed (or data changed which affects status), broadcast the list
  if (projectListChanged || anyDataChanged) {
    broadcastEvent("projects", buildProjectsList());
  }
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
const FALLBACK_PORTS = [6174, 1729, 2520, 5040, 8128, 6765, 4181];

async function findPort(): Promise<number> {
  if (portExplicit) {
    return preferredPort;
  }

  for (const port of FALLBACK_PORTS) {
    if (await isPortFree(port)) return port;
  }

  let port = FALLBACK_PORTS[FALLBACK_PORTS.length - 1]! + 1;
  while (!(await isPortFree(port))) port++;
  return port;
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, fetch: () => new Response() });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

// --- Start server ---
const port = await findPort();

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

    if (url.pathname === "/") {
      return new Response(Bun.file(resolve(import.meta.dir, "index.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

// Initial sync and poll
await syncProjectsFromFile();
for (const state of projects.values()) {
  await pollProject(state);
}

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
