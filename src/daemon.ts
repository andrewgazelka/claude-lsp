import { spawn } from "bun";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { Diagnostic } from "./utils";

const STATE_DIR = "/tmp/claude-lsp";
const BASE_PORT = 19200; // Start looking for ports here

interface DaemonState {
  pid: number;
  port: number;
  projectPath: string;
  startedAt: number;
  initialized: boolean;
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

function getStatePath(projectPath: string): string {
  return join(STATE_DIR, `ra-${hashPath(projectPath)}.json`);
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDaemonState(projectPath: string): DaemonState | null {
  const statePath = getStatePath(projectPath);
  if (!existsSync(statePath)) return null;

  try {
    const state: DaemonState = JSON.parse(readFileSync(statePath, "utf-8"));
    if (isProcessRunning(state.pid)) {
      return state;
    }
    unlinkSync(statePath);
  } catch {
    // Invalid state
  }
  return null;
}

async function findRustAnalyzer(): Promise<string | null> {
  // Try nix first (most reliable)
  try {
    const proc = spawn(
      ["nix", "build", "--no-link", "--print-out-paths", "nixpkgs#rust-analyzer"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0 && output.trim()) {
      return `${output.trim()}/bin/rust-analyzer`;
    }
  } catch {}

  // Try PATH
  try {
    const proc = spawn(["which", "rust-analyzer"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0 && output.trim()) {
      return output.trim();
    }
  } catch {}

  return null;
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    try {
      const server = Bun.listen({
        port,
        hostname: "127.0.0.1",
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      });
      server.stop();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("No free port found");
}

/**
 * JSON-RPC message utilities
 */
function encodeMessage(msg: object): string {
  const content = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
}

function parseMessages(buffer: string): { messages: any[]; remaining: string } {
  const messages: any[] = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length: (\d+)/i);
    if (!match) {
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }

    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;

    if (remaining.length < end) break;

    try {
      messages.push(JSON.parse(remaining.slice(start, end)));
    } catch {}

    remaining = remaining.slice(end);
  }

  return { messages, remaining };
}

/**
 * Spawn rust-analyzer and create a TCP proxy for it
 */
async function spawnDaemon(projectPath: string): Promise<DaemonState> {
  ensureStateDir();

  const raPath = await findRustAnalyzer();
  if (!raPath) {
    throw new Error("rust-analyzer not found");
  }

  const port = await findFreePort(BASE_PORT + parseInt(hashPath(projectPath), 16) % 100);

  // Spawn rust-analyzer
  const ra = spawn([raPath], {
    cwd: projectPath,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Create TCP server that proxies to RA
  const server = Bun.listen({
    port,
    hostname: "127.0.0.1",
    socket: {
      async data(socket, data) {
        // Forward to RA stdin
        ra.stdin.write(data);
      },
      open(socket) {
        // Pipe RA stdout to this socket
        const reader = ra.stdout.getReader();
        (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            socket.write(value);
          }
        })();
      },
      close() {},
      error() {},
    },
  });

  const state: DaemonState = {
    pid: ra.pid,
    port,
    projectPath,
    startedAt: Date.now(),
    initialized: false,
  };

  writeFileSync(getStatePath(projectPath), JSON.stringify(state));

  // Clean up on exit
  ra.exited.then(() => {
    server.stop();
    const statePath = getStatePath(projectPath);
    if (existsSync(statePath)) unlinkSync(statePath);
  });

  return state;
}

/**
 * Simple LSP client that connects via TCP
 */
class SimpleLspClient {
  private socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private buffer = "";
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private diagnostics = new Map<string, Diagnostic[]>();

  async connect(port: number): Promise<void> {
    this.socket = await Bun.connect({
      port,
      hostname: "127.0.0.1",
      socket: {
        data: (_, data) => {
          this.buffer += new TextDecoder().decode(data);
          this.processBuffer();
        },
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });
  }

  private processBuffer() {
    const { messages, remaining } = parseMessages(this.buffer);
    this.buffer = remaining;

    for (const msg of messages) {
      if ("id" in msg && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method === "textDocument/publishDiagnostics") {
        this.diagnostics.set(msg.params.uri, msg.params.diagnostics);
      }
    }
  }

  private send(msg: object) {
    this.socket?.write(encodeMessage(msg));
  }

  private request<T>(method: string, params?: object): Promise<T> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });
  }

  private notify(method: string, params?: object) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });
    this.notify("initialized", {});
  }

  didOpen(uri: string, text: string) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "rust", version: 1, text },
    });
  }

  didChange(uri: string, text: string, version: number) {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  async waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<Diagnostic[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const diags = this.diagnostics.get(uri);
      if (diags !== undefined) return diags;
      await Bun.sleep(100);
    }
    return [];
  }

  close() {
    this.socket?.end();
  }
}

// Cache client connections
const clientCache = new Map<string, SimpleLspClient>();

export async function ensureDaemon(projectPath: string): Promise<number> {
  let state = getDaemonState(projectPath);

  if (!state) {
    state = await spawnDaemon(projectPath);
    // Give RA time to start
    await Bun.sleep(500);
  }

  return state.port;
}

export async function queryDiagnostics(
  port: number,
  filePath: string,
  projectPath: string
): Promise<Diagnostic[]> {
  const cacheKey = `${projectPath}:${port}`;
  let client = clientCache.get(cacheKey);

  if (!client) {
    client = new SimpleLspClient();
    await client.connect(port);
    await client.initialize(`file://${projectPath}`);
    clientCache.set(cacheKey, client);
  }

  const fileUri = `file://${filePath}`;
  const content = await Bun.file(filePath).text();

  client.didOpen(fileUri, content);

  // Wait for diagnostics to arrive
  const diagnostics = await client.waitForDiagnostics(fileUri, 3000);

  return diagnostics;
}
