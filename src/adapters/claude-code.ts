import { readdir, readFile, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import { filterMessage } from "../core/privacy";
import type { ContentBlock, Message, OperationDiagnostic, Session } from "../types";
import { asRecord, collectJsonlFilesWithDiagnostics, jsonlLinesWithDiagnostics, stringValue } from "./fs-utils";
import type { AdapterParseOptions, AdapterScanResult, TranscriptAdapter } from "./types";

interface ClaudeCodeAdapterOptions extends AdapterParseOptions {
  appSessionRoots?: string[];
}

interface ClaudeAppMetadata {
  path: string;
  cliSessionId: string;
  cwd: string;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

interface ClaudeAppMetadataScanResult {
  metadata: ClaudeAppMetadata[];
  diagnostics: OperationDiagnostic[];
}

export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly provider = "claude-code" as const;

  constructor(private readonly options: ClaudeCodeAdapterOptions) {}

  async scan(roots: string[]): Promise<AdapterScanResult> {
    const { files, diagnostics } = await collectJsonlFilesWithDiagnostics(roots, this.provider);
    const sessions: Session[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file.path, "utf8");
        const parsed = jsonlLinesWithDiagnostics(content, file.path, this.provider);
        diagnostics.push(...parsed.diagnostics);
        const meta = this.parseMetadata(file.path, parsed.lines);
        const sessionId = meta.id ?? basename(file.path, ".jsonl");
        const messages = this.parseMessagesFromLines(file.path, parsed.lines, sessionId);
        const userMessages = messages.filter((message) => message.role === "user");

        sessions.push({
          id: sessionId,
          provider: this.provider,
          sourcePath: file.path,
          projectPath: meta.cwd,
          projectId: null,
          title: meta.title ?? meta.summary ?? userMessages.at(-1)?.content.slice(0, 80) ?? null,
          summary: meta.summary,
          lastPrompt: userMessages.at(-1)?.content ?? null,
          createdAt: meta.createdAt ?? file.mtimeMs,
          updatedAt: file.mtimeMs,
          messageCount: messages.length,
          rounds: userMessages.length,
          status: "new"
        });
      } catch (error) {
        diagnostics.push({
          provider: this.provider,
          sourcePath: file.path,
          code: "parse-failed",
          severity: "warning",
          message: `Could not read Claude Code session: ${error instanceof Error ? error.message : String(error)}.`,
          recoveryActionLabel: "Open source transcript"
        });
      }
    }

    const metadataScan = await this.scanAppMetadata();
    diagnostics.push(...metadataScan.diagnostics);
    return { sessions: mergeAppMetadata(sessions, metadataScan.metadata), diagnostics };
  }

  async parseMessages(sourcePath: string, sessionId?: string): Promise<Message[]> {
    if (!sourcePath.endsWith(".jsonl")) {
      return [];
    }
    const content = await readFile(sourcePath, "utf8");
    const parsed = jsonlLinesWithDiagnostics(content, sourcePath, this.provider);
    return this.parseMessagesFromLines(sourcePath, parsed.lines, sessionId ?? basename(sourcePath, ".jsonl"));
  }

  private parseMetadata(
    sourcePath: string,
    lines: Array<{ lineNumber: number; value: unknown }>
  ): {
    id: string | null;
    cwd: string | null;
    title: string | null;
    summary: string | null;
    createdAt: number | null;
  } {
    let id: string | null = null;
    let cwd: string | null = null;
    let title: string | null = null;
    let summary: string | null = null;
    let createdAt: number | null = null;

    for (const { value } of lines) {
      const record = asRecord(value);
      if (!record) {
        continue;
      }

      id = stringValue(record.sessionId) ?? stringValue(record.session_id) ?? id;
      cwd = stringValue(record.cwd) ?? stringValue(record.projectPath) ?? cwd;
      title =
        stringValue(record.customTitle) ??
        stringValue(record.aiTitle) ??
        stringValue(record.slug) ??
        title;
      summary = stringValue(record.summary) ?? summary;
      createdAt = timestampToMs(stringValue(record.timestamp)) ?? createdAt;
    }

    return {
      id,
      cwd: cwd ?? decodeClaudeProjectPath(dirname(sourcePath)),
      title,
      summary,
      createdAt
    };
  }

  private async scanAppMetadata(): Promise<ClaudeAppMetadataScanResult> {
    const metadata: ClaudeAppMetadata[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    for (const root of this.options.appSessionRoots ?? []) {
      await collectClaudeAppMetadata(root, metadata, diagnostics, true);
    }
    return { metadata, diagnostics };
  }

  private parseMessagesFromLines(
    sourcePath: string,
    lines: Array<{ lineNumber: number; value: unknown }>,
    sessionId: string
  ): Message[] {
    const messages: Message[] = [];

    for (const { lineNumber, value } of lines) {
      const record = asRecord(value);
      if (!record) {
        continue;
      }

      const message = this.messageFromRecord(sessionId, lineNumber, record);
      if (!message) {
        continue;
      }

      const filtered = filterMessage(message, {
        patterns: this.options.privacyPatterns,
        maxQuoteLength: this.options.maxQuoteLength
      });
      if (filtered) {
        messages.push(filtered);
      }
    }

    return messages;
  }

  private messageFromRecord(
    sessionId: string,
    lineNumber: number,
    record: Record<string, unknown>
  ): Message | null {
    const type = stringValue(record.type);
    const timestamp = stringValue(record.timestamp);
    const rawMessage = asRecord(record.message) ?? record;
    const role = normalizeClaudeRole(stringValue(rawMessage.role) ?? type);
    const blocks = extractClaudeBlocks(rawMessage.content);
    const content =
      blocks
        .map((block) => {
          if (block.type === "text" || block.type === "thinking") {
            return block.text;
          }
          if (block.type === "tool_result") {
            return block.content;
          }
          return `${block.name} ${JSON.stringify(block.input ?? {})}`;
        })
        .join("\n")
        .trim() || stringValue(record.content);

    if (!content) {
      return null;
    }

    return {
      id: stringValue(record.uuid) ?? stringValue(record.id) ?? `${sessionId}:${lineNumber}`,
      sessionId,
      role,
      content,
      timestamp,
      lineNumber,
      isTool: blocks.some((block) => block.type === "tool_use" || block.type === "tool_result"),
      blocks
    };
  }
}

async function collectClaudeAppMetadata(
  root: string,
  output: ClaudeAppMetadata[],
  diagnostics: OperationDiagnostic[],
  isRoot = false
): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    diagnostics.push({
      provider: "claude-code",
      sourcePath: root,
      code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "path-missing",
      severity: "warning",
      message: code === "EACCES" || code === "EPERM"
        ? `Cannot read Claude desktop metadata path ${root}: permission denied.`
        : `Claude desktop metadata path does not exist or cannot be read: ${root}.`,
      recoveryActionLabel: "Check source path"
    });
    return 0;
  }

  let candidateCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      candidateCount += await collectClaudeAppMetadata(path, output, diagnostics);
      continue;
    }
    if (!entry.isFile() || !entry.name.startsWith("local_") || !entry.name.endsWith(".json")) {
      continue;
    }
    candidateCount += 1;
    const parsed = await parseClaudeAppMetadata(path, diagnostics);
    if (parsed) {
      output.push(parsed);
    }
  }

  if (isRoot && candidateCount === 0) {
    diagnostics.push({
      provider: "claude-code",
      sourcePath: root,
      code: "empty-directory",
      severity: "info",
      message: `No Claude desktop local_*.json metadata files found under ${root}.`,
      recoveryActionLabel: "Run Refresh Sessions"
    });
  }

  return candidateCount;
}

async function parseClaudeAppMetadata(
  path: string,
  diagnostics: OperationDiagnostic[]
): Promise<ClaudeAppMetadata | null> {
  try {
    const content = await readFile(path, "utf8");
    const value = asRecord(JSON.parse(content) as unknown);
    if (!value) {
      diagnostics.push(invalidClaudeAppMetadataDiagnostic(path, "metadata JSON must be an object."));
      return null;
    }
    const cliSessionId = stringValue(value.cliSessionId) ?? stringValue(value.sessionId);
    const cwd = stringValue(value.cwd);
    if (!cliSessionId || !cwd) {
      diagnostics.push(invalidClaudeAppMetadataDiagnostic(path, "metadata is missing cliSessionId/sessionId or cwd."));
      return null;
    }
    const info = await stat(path);
    return {
      path,
      cliSessionId,
      cwd,
      title: stringValue(value.title) ?? stringValue(value.customTitle),
      createdAt: msValue(value.createdAt) ?? info.birthtimeMs,
      updatedAt: msValue(value.lastActivityAt) ?? msValue(value.updatedAt) ?? info.mtimeMs
    };
  } catch (error) {
    diagnostics.push({
      provider: "claude-code",
      sourcePath: path,
      code: "parse-failed",
      severity: "warning",
      message: `Could not parse Claude desktop metadata: ${error instanceof Error ? error.message : String(error)}.`,
      recoveryActionLabel: "Open source transcript"
    });
    return null;
  }
}

function mergeAppMetadata(sessions: Session[], metadata: ClaudeAppMetadata[]): Session[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const item of selectPreferredMetadata(metadata)) {
    const existing = byId.get(item.cliSessionId);
    if (existing) {
      existing.projectPath = item.cwd || existing.projectPath;
      existing.title = item.title ?? existing.title;
      existing.createdAt = item.createdAt ? Math.min(existing.createdAt, item.createdAt) : existing.createdAt;
      existing.updatedAt = item.updatedAt ? Math.max(existing.updatedAt, item.updatedAt) : existing.updatedAt;
      continue;
    }
    const updatedAt = item.updatedAt ?? Date.now();
    byId.set(item.cliSessionId, {
      id: item.cliSessionId,
      provider: "claude-code",
      sourcePath: item.path,
      projectPath: item.cwd,
      projectId: null,
      title: item.title ?? basename(item.cwd),
      summary: null,
      lastPrompt: null,
      createdAt: item.createdAt ?? updatedAt,
      updatedAt,
      messageCount: 0,
      rounds: 0,
      status: "new"
    });
  }
  return Array.from(byId.values());
}

function selectPreferredMetadata(metadata: ClaudeAppMetadata[]): ClaudeAppMetadata[] {
  const byId = new Map<string, ClaudeAppMetadata>();
  for (const item of metadata.sort(compareClaudeAppMetadata)) {
    byId.set(item.cliSessionId, item);
  }
  return Array.from(byId.values()).sort(compareClaudeAppMetadata);
}

function compareClaudeAppMetadata(left: ClaudeAppMetadata, right: ClaudeAppMetadata): number {
  const leftUpdated = left.updatedAt ?? 0;
  const rightUpdated = right.updatedAt ?? 0;
  if (leftUpdated !== rightUpdated) {
    return leftUpdated - rightUpdated;
  }
  return left.path.localeCompare(right.path);
}

function invalidClaudeAppMetadataDiagnostic(path: string, reason: string): OperationDiagnostic {
  return {
    provider: "claude-code",
    sourcePath: path,
    code: "extraction-gap",
    severity: "info",
    message: `Skipped Claude desktop metadata because ${reason}`,
    recoveryActionLabel: "Check source path"
  };
}

function msValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractClaudeBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string" && content.trim()) {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block): ContentBlock[] => {
    const record = asRecord(block);
    if (!record) {
      return [];
    }

    const type = stringValue(record.type);
    if (type === "text") {
      const text = stringValue(record.text);
      return text ? [{ type: "text", text }] : [];
    }
    if (type === "thinking") {
      const text = stringValue(record.thinking) ?? stringValue(record.text);
      return text ? [{ type: "thinking", text }] : [];
    }
    if (type === "tool_use") {
      return [{ type: "tool_use", name: stringValue(record.name) ?? "tool", input: record.input }];
    }
    if (type === "tool_result") {
      const result = stringValue(record.content) ?? JSON.stringify(record.content ?? "");
      return [{ type: "tool_result", content: result }];
    }
    return [];
  });
}

function normalizeClaudeRole(role: string | null): Message["role"] {
  if (role === "assistant" || role === "tool" || role === "system") {
    return role;
  }
  return "user";
}

function decodeClaudeProjectPath(projectDir: string): string | null {
  const name = basename(projectDir);
  if (!name || name === "projects") {
    return null;
  }
  if (!name.startsWith("-")) {
    return null;
  }
  return name.replace(/--/g, "/.").replace(/-/g, "/");
}

function timestampToMs(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}
