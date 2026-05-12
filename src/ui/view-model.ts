import type { OperationDiagnostic, Provider, Session, SessionStatus } from "../types";

export interface SessionFilters {
  provider: Provider | "all";
  status: SessionStatus | "all";
  projectId: string | "all" | "unmapped";
  search: string;
}

export interface SessionCounts {
  total: number;
  byProvider: Record<Provider, number>;
  byStatus: Record<SessionStatus, number>;
  unmapped: number;
}

export const DEFAULT_FILTERS: SessionFilters = {
  provider: "all",
  status: "all",
  projectId: "all",
  search: ""
};

export function filterSessions(sessions: Session[], filters: SessionFilters): Session[] {
  const query = filters.search.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filters.provider !== "all" && session.provider !== filters.provider) {
      return false;
    }
    if (filters.status !== "all" && session.status !== filters.status) {
      return false;
    }
    if (filters.projectId === "unmapped" && session.projectId) {
      return false;
    }
    if (filters.projectId !== "all" && filters.projectId !== "unmapped" && session.projectId !== filters.projectId) {
      return false;
    }
    if (!query) {
      return true;
    }
    return [
      session.title,
      session.summary,
      session.lastPrompt,
      session.projectPath,
      session.sourcePath,
      session.projectId
    ]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(query));
  });
}

export function countSessions(sessions: Session[]): SessionCounts {
  const byProvider: Record<Provider, number> = {
    codex: 0,
    "claude-code": 0,
    cursor: 0,
    unknown: 0
  };
  const byStatus: Record<SessionStatus, number> = {
    new: 0,
    reviewed: 0,
    merged: 0,
    ignored: 0
  };

  for (const session of sessions) {
    byProvider[session.provider] += 1;
    byStatus[session.status] += 1;
  }

  return {
    total: sessions.length,
    byProvider,
    byStatus,
    unmapped: sessions.filter((session) => !session.projectId).length
  };
}

export function recoveryLabels(diagnostics: OperationDiagnostic[]): string[] {
  return Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.recoveryActionLabel).filter(Boolean)));
}

export function diagnosticSummary(diagnostic: OperationDiagnostic): string {
  const provider = diagnostic.provider ? `${diagnostic.provider} ` : "";
  const source = diagnostic.sourcePath ? ` ${diagnostic.sourcePath}` : "";
  return `${provider}${diagnostic.code}${source}: ${diagnostic.message}`;
}
