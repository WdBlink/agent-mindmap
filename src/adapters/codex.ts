import { readFile } from "fs/promises";
import { basename } from "path";
import { filterMessage } from "../core/privacy";
import type { Message, Session } from "../types";
import { asRecord, collectJsonlFilesWithDiagnostics, jsonlLinesWithDiagnostics, stringValue } from "./fs-utils";
import type { AdapterParseOptions, AdapterScanResult, TranscriptAdapter } from "./types";

export class CodexAdapter implements TranscriptAdapter {
  readonly provider = "codex" as const;

  constructor(private readonly options: AdapterParseOptions) {}

  async scan(roots: string[]): Promise<AdapterScanResult> {
    const { files, diagnostics } = await collectJsonlFilesWithDiagnostics(roots, this.provider);
    const sessions: Session[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file.path, "utf8");
        const parsed = jsonlLinesWithDiagnostics(content, file.path, this.provider);
        diagnostics.push(...parsed.diagnostics);
        const meta = this.parseMetadata(file.path, parsed.lines);
        const sessionId = meta.id ?? extractCodexSessionId(file.path);
        const messages = this.parseMessagesFromLines(file.path, parsed.lines, sessionId);
        const userMessages = messages.filter((message) => message.role === "user");
        const lastPrompt = userMessages.at(-1)?.content ?? null;

        sessions.push({
          id: sessionId,
          provider: this.provider,
          sourcePath: file.path,
          projectPath: meta.cwd,
          projectId: null,
          title: meta.title ?? titleFromPath(meta.cwd, file.path),
          summary: meta.summary,
          lastPrompt,
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
          message: `Could not read Codex session: ${error instanceof Error ? error.message : String(error)}.`,
          recoveryActionLabel: "Open source transcript"
        });
      }
    }

    return { sessions, diagnostics };
  }

  async parseMessages(sourcePath: string, sessionId?: string): Promise<Message[]> {
    const content = await readFile(sourcePath, "utf8");
    const parsed = jsonlLinesWithDiagnostics(content, sourcePath, this.provider);
    return this.parseMessagesFromLines(sourcePath, parsed.lines, sessionId ?? extractCodexSessionId(sourcePath));
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

      const type = stringValue(record.type);
      const payload = asRecord(record.payload);
      if (type === "session_meta" && payload) {
        id = id ?? stringValue(payload.id);
        cwd = cwd ?? stringValue(payload.cwd) ?? stringValue(payload.project_path);
        title = title ?? stringValue(payload.title) ?? stringValue(payload.agent_nickname);
        summary = summary ?? stringValue(payload.summary);
        createdAt = createdAt ?? timestampToMs(stringValue(payload.timestamp));
      }
    }

    return {
      id,
      cwd,
      title,
      summary,
      createdAt: createdAt ?? timestampToMs(extractDateFromCodexPath(sourcePath))
    };
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

      const type = stringValue(record.type);
      const payload = asRecord(record.payload);
      const timestamp = stringValue(record.timestamp) ?? stringValue(payload?.timestamp);
      const maybeMessage =
        this.messageFromEvent(sessionId, lineNumber, type, payload, timestamp) ??
        this.messageFromResponseItem(sessionId, sourcePath, lineNumber, payload, timestamp) ??
        null;

      if (!maybeMessage) {
        continue;
      }

      const filtered = filterMessage(maybeMessage, {
        patterns: this.options.privacyPatterns,
        maxQuoteLength: this.options.maxQuoteLength
      });
      if (filtered) {
        messages.push(filtered);
      }
    }

    return messages;
  }

  private messageFromResponseItem(
    sessionId: string,
    sourcePath: string,
    lineNumber: number,
    payload: Record<string, unknown> | null,
    timestamp: string | null
  ): Message | null {
    const item = asRecord(payload?.item) ?? payload;
    if (!item) {
      return null;
    }

    const itemType = stringValue(item.type);
    if (itemType === "message") {
      const role = normalizeRole(stringValue(item.role));
      const content = extractCodexContent(item);
      if (!content) {
        return null;
      }
      return {
        id: stringValue(item.id) ?? `${sessionId}:${lineNumber}`,
        sessionId,
        role,
        content,
        timestamp,
        lineNumber,
        isTool: role === "tool"
      };
    }

    if (itemType === "function_call" || itemType === "tool_call") {
      const name = stringValue(item.name) ?? "tool";
      const content = JSON.stringify({ name, arguments: item.arguments ?? item.input ?? null });
      return {
        id: stringValue(item.id) ?? `${sessionId}:${lineNumber}`,
        sessionId,
        role: "tool",
        content,
        timestamp,
        lineNumber,
        isTool: true,
        blocks: [{ type: "tool_use", name, input: item.arguments ?? item.input }]
      };
    }

    if (itemType === "function_call_output" || itemType === "tool_result") {
      const content =
        stringValue(item.output) ??
        stringValue(item.content) ??
        JSON.stringify(item.output ?? item.content ?? {});
      return {
        id: stringValue(item.id) ?? `${sessionId}:${lineNumber}`,
        sessionId,
        role: "tool",
        content,
        timestamp,
        lineNumber,
        isTool: true,
        blocks: [{ type: "tool_result", content }]
      };
    }

    return null;
  }

  private messageFromEvent(
    sessionId: string,
    lineNumber: number,
    type: string | null,
    payload: Record<string, unknown> | null,
    timestamp: string | null
  ): Message | null {
    if (!payload || type !== "event_msg") {
      return null;
    }

    const message = stringValue(payload.message) ?? stringValue(payload.text);
    if (!message) {
      return null;
    }

    const role = /^user\b|^user:/i.test(message) ? "user" : "system";
    return {
      id: `${sessionId}:${lineNumber}`,
      sessionId,
      role,
      content: message,
      timestamp,
      lineNumber,
      isMeta: role === "system"
    };
  }
}

function extractCodexSessionId(sourcePath: string): string {
  const match = basename(sourcePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,36})/i);
  return match?.[1] ?? basename(sourcePath, ".jsonl");
}

function extractDateFromCodexPath(sourcePath: string): string | null {
  const match = sourcePath.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z` : null;
}

function extractCodexContent(item: Record<string, unknown>): string | null {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content.flatMap((block) => {
    const record = asRecord(block);
    if (!record) {
      return [];
    }
    return (
      stringValue(record.text) ??
      stringValue(record.content) ??
      stringValue(record.output_text) ??
      []
    );
  });

  return parts.length ? parts.join("\n") : null;
}

function normalizeRole(role: string | null): Message["role"] {
  if (role === "assistant" || role === "tool" || role === "system") {
    return role;
  }
  return "user";
}

function timestampToMs(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

function titleFromPath(projectPath: string | null, sourcePath: string): string {
  if (projectPath) {
    return basename(projectPath);
  }
  return basename(sourcePath, ".jsonl");
}
