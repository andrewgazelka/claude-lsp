#!/usr/bin/env bun
/**
 * Claude Code Hook: Fast Rust type checking via persistent rust-analyzer
 *
 * This hook runs after Write/Edit on .rs files and queries a persistent
 * rust-analyzer daemon for diagnostics. The daemon is shared across
 * all Claude Code sessions working on the same project.
 *
 * Exit codes:
 * - 0: Success (no errors or not a .rs file)
 * - 2: Blocking error (diagnostics shown to Claude)
 */

import { findCargoRoot, formatDiagnostics } from "./utils";
import { ensureDaemon, queryDiagnostics } from "./daemon";

interface HookInput {
  tool_input?: {
    file_path?: string;
  };
  tool_result?: {
    filePath?: string;
  };
  cwd?: string;
}

async function main() {
  // Read hook input from stdin
  const input = await Bun.stdin.text();
  if (!input) process.exit(0);

  let data: HookInput;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Get file path from tool input
  const filePath = data.tool_input?.file_path ?? data.tool_result?.filePath ?? "";
  if (!filePath.endsWith(".rs")) process.exit(0);

  // Find Cargo workspace root
  const projectRoot = await findCargoRoot(filePath);
  if (!projectRoot) {
    // Not a Cargo project, fall back to rustfmt check
    await fallbackSyntaxCheck(filePath);
    process.exit(0);
  }

  try {
    // Ensure daemon is running and get port
    const port = await ensureDaemon(projectRoot);

    // Query diagnostics
    const diagnostics = await queryDiagnostics(port, filePath, projectRoot);

    // Filter to errors only (severity 1)
    const errors = diagnostics.filter((d) => d.severity === 1);

    if (errors.length > 0) {
      console.error(formatDiagnostics(errors));
      process.exit(2); // Blocking error - shown to Claude
    }

    // Warnings - just log, don't block
    const warnings = diagnostics.filter((d) => d.severity === 2);
    if (warnings.length > 0) {
      console.error(`[warnings]\n${formatDiagnostics(warnings)}`);
      // Exit 0 - non-blocking
    }
  } catch (e: any) {
    // Daemon failed, fall back to syntax check
    console.error(`[claude-lsp] Daemon error: ${e.message}, falling back to rustfmt`);
    await fallbackSyntaxCheck(filePath);
  }
}

/**
 * Fallback: Use rustfmt for fast syntax checking only
 */
async function fallbackSyntaxCheck(filePath: string) {
  try {
    const proc = Bun.spawn(["rustfmt", "--check", "--edition", "2024", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 && stderr) {
      console.error(stderr);
      process.exit(2);
    }
  } catch {
    // rustfmt not available, silently continue
  }
}

main().catch((e) => {
  console.error(`[claude-lsp] Fatal error: ${e.message}`);
  process.exit(1);
});
