import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import type { AgentMindmapSettings } from "../settings";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { CodexAdapter } from "../adapters/codex";
import type { TranscriptAdapter } from "../adapters/types";
import type { Message, OperationDiagnostic, Session, SessionCacheEntry } from "../types";
import { effectiveClaudeAppSessionRoots, effectiveClaudeProjectRoots, effectiveCodexSessionRoots } from "./source-discovery";
import { SessionCache } from "./storage";

export interface SessionScanResult {
  sessions: Session[];
  diagnostics: OperationDiagnostic[];
}

export class SessionService {
  private readonly adapters: TranscriptAdapter[];

  constructor(
    private readonly settings: AgentMindmapSettings,
    private readonly cache: SessionCache
  ) {
    const adapterOptions = {
      privacyPatterns: settings.privacyPatterns,
      maxQuoteLength: settings.maxQuoteLength
    };
    this.adapters = [
      new CodexAdapter(adapterOptions),
      new ClaudeCodeAdapter({
        ...adapterOptions,
        appSessionRoots: effectiveClaudeAppSessionRoots(settings)
      })
    ];
  }

  async scanAll(): Promise<Session[]> {
    return (await this.scanAllWithDiagnostics()).sessions;
  }

  async scanAllWithDiagnostics(): Promise<SessionScanResult> {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => {
        const roots = adapter.provider === "codex"
          ? effectiveCodexSessionRoots(this.settings)
          : effectiveClaudeProjectRoots(this.settings);
        try {
          return await adapter.scan(roots);
        } catch (error) {
          return {
            sessions: [],
            diagnostics: [
              {
                provider: adapter.provider,
                code: "provider-failed" as const,
                severity: "error" as const,
                message: `${adapter.provider} scan failed: ${error instanceof Error ? error.message : String(error)}.`,
                recoveryActionLabel: "Check source path"
              }
            ]
          };
        }
      })
    );

    const sessions = dedupeSessions(results.flatMap((result) => result.sessions));
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const sorted = sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    await this.updateCache(sorted);
    return { sessions: sorted, diagnostics };
  }

  async parseMessages(session: Session): Promise<Message[]> {
    const adapter = this.adapters.find((candidate) => candidate.provider === session.provider);
    if (!adapter) {
      return [];
    }
    return adapter.parseMessages(session.sourcePath, session.id);
  }

  async saveSession(session: Session): Promise<void> {
    try {
      const info = await stat(session.sourcePath);
      const contentHash = await hashFile(session.sourcePath);
      await this.cache.put({
        path: session.sourcePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        contentHash,
        session
      });
    } catch {
      await this.cache.put({
        path: session.sourcePath,
        size: 0,
        mtimeMs: Date.now(),
        session
      });
    }
  }

  private async updateCache(sessions: Session[]): Promise<void> {
    const cache = await this.cache.load();

    for (const session of sessions) {
      try {
        const info = await stat(session.sourcePath);
        const contentHash = await hashFile(session.sourcePath);
        const cachedEntry = cache.entries[session.sourcePath];
        const cached = cachedEntry?.session;
        const cachedStillCurrent =
          cached &&
          cachedEntry?.size === info.size &&
          cachedEntry.mtimeMs === info.mtimeMs &&
          cachedEntry.contentHash === contentHash;
        const mergedSession: Session = cachedStillCurrent
          ? {
              ...session,
              projectId: cached.projectId ?? session.projectId,
              status: cached.status ?? session.status
            }
          : session;
        Object.assign(session, mergedSession);
        const entry: SessionCacheEntry = {
          path: session.sourcePath,
          size: info.size,
          mtimeMs: info.mtimeMs,
          contentHash,
          session: mergedSession
        };
        cache.entries[entry.path] = entry;
      } catch {
        continue;
      }
    }

    const livePaths = new Set(sessions.map((session) => session.sourcePath));
    for (const path of Object.keys(cache.entries)) {
      if (!livePaths.has(path)) {
        delete cache.entries[path];
      }
    }

    await this.cache.save(cache);
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function dedupeSessions(sessions: Session[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const session of sessions) {
    const key = `${session.provider}:${session.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, session);
      continue;
    }
    byKey.set(key, preferSession(existing, session));
  }
  return Array.from(byKey.values());
}

function preferSession(left: Session, right: Session): Session {
  const leftTranscript = left.sourcePath.endsWith(".jsonl");
  const rightTranscript = right.sourcePath.endsWith(".jsonl");
  const base = rightTranscript && !leftTranscript ? right : left;
  const enrichment = base === left ? right : left;
  return {
    ...base,
    title: enrichment.title ?? base.title,
    summary: base.summary ?? enrichment.summary,
    lastPrompt: base.lastPrompt ?? enrichment.lastPrompt,
    projectPath: enrichment.projectPath ?? base.projectPath,
    createdAt: Math.min(base.createdAt, enrichment.createdAt),
    updatedAt: Math.max(base.updatedAt, enrichment.updatedAt),
    messageCount: Math.max(base.messageCount, enrichment.messageCount),
    rounds: Math.max(base.rounds, enrichment.rounds)
  };
}
