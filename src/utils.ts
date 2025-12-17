import { createHash } from "crypto";
import { existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Find the Cargo workspace root by walking up from a file path
 */
export async function findCargoRoot(filePath: string): Promise<string | null> {
  let dir = dirname(filePath);

  while (dir !== "/") {
    const cargoToml = join(dir, "Cargo.toml");
    if (existsSync(cargoToml)) {
      // Check if this is a workspace root (has [workspace] section)
      // or just a member crate
      const content = await Bun.file(cargoToml).text();
      if (content.includes("[workspace]") || !existsSync(join(dirname(dir), "Cargo.toml"))) {
        return dir;
      }
    }
    dir = dirname(dir);
  }

  return null;
}

/**
 * Generate a short hash for a project path (for socket naming)
 */
export function hashProjectPath(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

/**
 * Get the socket path for a project
 */
export function getSocketPath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return `/tmp/claude-lsp-ra-${hash}.sock`;
}

/**
 * Get the PID file path for a project
 */
export function getPidPath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return `/tmp/claude-lsp-ra-${hash}.pid`;
}

/**
 * Format LSP diagnostics for display
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
      const loc = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
      return `${severity}[${loc}]: ${d.message}`;
    })
    .join("\n");
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  severity?: number; // 1 = Error, 2 = Warning, 3 = Info, 4 = Hint
  code?: string | number;
  source?: string;
  message: string;
}
