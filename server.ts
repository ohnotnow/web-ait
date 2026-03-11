import { $ } from "bun";
import { resolve } from "path";

// --- CLI argument parsing ---
const args = process.argv.slice(2);
let projectPath = "./";
let preferredPort = 6174;
let portExplicit = false;
let pollInterval = 3;
let aitPath = "ait";

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--port") {
    preferredPort = parseInt(args[++i]!, 10);
    portExplicit = true;
  } else if (arg === "--poll") {
    pollInterval = parseInt(args[++i]!, 10);
  } else if (arg === "--ait-path") {
    aitPath = args[++i]!;
  } else if (!arg.startsWith("--")) {
    projectPath = arg;
  }
}

projectPath = resolve(projectPath);
const dbPath = resolve(projectPath, ".ait", "ait.db");

// --- ait command helpers ---
async function runAit(command: string[]): Promise<string> {
  const result = await $`${aitPath} --db ${dbPath} ${command}`.text();
  return result;
}

// --- State ---
let cachedData: { issues: unknown; status: unknown; config: unknown } | null = null;
let lastHash = "";
const sseClients = new Set<ReadableStreamDefaultController>();

async function fetchConfig(): Promise<unknown> {
  try {
    return JSON.parse(await runAit(["config"]));
  } catch {
    return { prefix: "unknown" };
  }
}

async function poll() {
  try {
    const [issuesRaw, statusRaw] = await Promise.all([
      runAit(["list", "--long", "--all"]),
      runAit(["status"]),
    ]);

    const hash = Bun.hash(issuesRaw + statusRaw).toString();
    if (hash === lastHash) return;
    lastHash = hash;

    const config = cachedData?.config ?? await fetchConfig();
    cachedData = {
      issues: JSON.parse(issuesRaw),
      status: JSON.parse(statusRaw),
      config,
    };

    broadcast(cachedData);
  } catch (e) {
    console.error("Poll error:", e);
  }
}

function broadcast(data: unknown) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(payload);
    } catch {
      sseClients.delete(controller);
    }
  }
}

// --- SSE handler ---
function handleSSE(): Response {
  const stream = new ReadableStream({
    start(controller) {
      sseClients.add(controller);
      // Send current data immediately if available
      if (cachedData) {
        controller.enqueue(`data: ${JSON.stringify(cachedData)}\n\n`);
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
    return preferredPort; // Let Bun.serve fail if busy
  }

  for (const port of FALLBACK_PORTS) {
    if (await isPortFree(port)) return port;
  }

  // Walk upward from last fallback
  let port = FALLBACK_PORTS[FALLBACK_PORTS.length - 1]! + 1;
  while (!(await isPortFree(port))) port++;
  return port;
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, fetch: () => new Response(), });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

// --- Start ---
const port = await findPort();

const server = Bun.serve({
  port,
  idleTimeout: 255, // max value — SSE connections are long-lived
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      return handleSSE();
    }

    if (url.pathname === "/") {
      return new Response(Bun.file(resolve(import.meta.dir, "index.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

// Fetch config once on startup, then start polling
cachedData = {
  issues: { issues: [] },
  status: { counts: {} },
  config: await fetchConfig(),
};

// Initial poll immediately
await poll();

// Poll loop
setInterval(poll, pollInterval * 1000);

console.log(`ait-web listening on http://localhost:${port} for ${projectPath}`);
