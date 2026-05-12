import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { OperationDiagnostic, Provider } from "../types";
import type { FileStatInfo } from "./types";

export interface CollectFilesResult {
  files: FileStatInfo[];
  diagnostics: OperationDiagnostic[];
}

export interface JsonlParseResult {
  lines: Array<{ lineNumber: number; value: unknown }>;
  diagnostics: OperationDiagnostic[];
}

export async function collectJsonlFiles(roots: string[]): Promise<FileStatInfo[]> {
  return (await collectJsonlFilesWithDiagnostics(roots, "unknown")).files;
}

export async function collectJsonlFilesWithDiagnostics(
  roots: string[],
  provider: Provider
): Promise<CollectFilesResult> {
  const files: FileStatInfo[] = [];
  const diagnostics: OperationDiagnostic[] = [];

  for (const root of roots) {
    await collectJsonlFilesFromRoot(root, files, diagnostics, provider, true);
  }

  return {
    files: files.sort((left, right) => right.mtimeMs - left.mtimeMs),
    diagnostics
  };
}

async function collectJsonlFilesFromRoot(
  root: string,
  output: FileStatInfo[],
  diagnostics: OperationDiagnostic[],
  provider: Provider,
  isRoot = false
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    diagnostics.push({
      provider,
      sourcePath: root,
      code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "path-missing",
      severity: "warning",
      message: code === "EACCES" || code === "EPERM"
        ? `Cannot read ${root}: permission denied.`
        : `Session path does not exist or cannot be read: ${root}.`,
      recoveryActionLabel: "Check source path"
    });
    return;
  }

  const before = output.length;
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFilesFromRoot(fullPath, output, diagnostics, provider);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const info = await stat(fullPath);
    output.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs });
  }

  if (isRoot && output.length === before) {
    diagnostics.push({
      provider,
      sourcePath: root,
      code: "empty-directory",
      severity: "info",
      message: `No JSONL session files found under ${root}.`,
      recoveryActionLabel: "Run Refresh Sessions"
    });
  }
}

export function jsonlLines(content: string): Array<{ lineNumber: number; value: unknown }> {
  return jsonlLinesWithDiagnostics(content, "unknown", "unknown").lines;
}

export function jsonlLinesWithDiagnostics(
  content: string,
  sourcePath: string,
  provider: Provider
): JsonlParseResult {
  const lines: Array<{ lineNumber: number; value: unknown }> = [];
  const diagnostics: OperationDiagnostic[] = [];

  for (const { line, lineNumber } of content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)) {
    try {
      lines.push({ lineNumber, value: JSON.parse(line) as unknown });
    } catch (error) {
      diagnostics.push({
        provider,
        sourcePath,
        code: "parse-failed",
        severity: "warning",
        message: `Could not parse JSONL line ${lineNumber}: ${error instanceof Error ? error.message : "invalid JSON"}.`,
        recoveryActionLabel: "Open source transcript"
      });
    }
  }

  return { lines, diagnostics };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
