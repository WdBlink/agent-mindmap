import { stableId } from "./ids";
import { quoteForTrace } from "./privacy";
import type {
  Artifact,
  Decision,
  ExtractedProjectMemory,
  Message,
  Session,
  Task,
  TimelineEvent,
  Trace
} from "../types";

export interface HeuristicExtractorOptions {
  maxQuoteLength: number;
}

const DECISION_PATTERNS = [
  /决定/,
  /结论/,
  /\bdecided\b/i,
  /\bdecision\b/i,
  /\buse\b.+\binstead\b/i,
  /不做/,
  /out of scope/i
];

const TASK_PATTERNS = [
  /todo/i,
  /待办/,
  /下一步/,
  /需要/,
  /实现/,
  /修复/,
  /add\b/i,
  /implement\b/i
];

const BLOCKER_PATTERNS = [/blocked/i, /阻塞/, /失败/, /报错/, /blocker/i, /无法/];
const IDEA_PATTERNS = [/idea/i, /想法/, /可以考虑/, /后续/];
const ARTIFACT_PATTERNS = [/[\w./-]+\.(md|ts|tsx|js|json|canvas|py|yml|yaml|toml|txt)\b/i];

export function extractProjectMemoryHeuristic(
  session: Session,
  messages: Message[],
  projectId: string,
  options: HeuristicExtractorOptions
): ExtractedProjectMemory {
  const relevant = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const traces = relevant.map((message) => traceForMessage(session, message, options.maxQuoteLength));
  const goals = uniqueNonEmpty([
    session.summary,
    firstMatchingLine(relevant, [/目标/, /\bgoal\b/i, /验收/])
  ]);
  const currentState = uniqueNonEmpty([
    session.lastPrompt,
    firstMatchingLine(relevant.slice().reverse(), [/当前/, /完成/, /implemented/i, /created/i])
  ]);
  const decisions = extractDecisions(session, relevant, options);
  const tasks = extractTasks(session, relevant, options);
  const artifacts = extractArtifacts(session, relevant, options);
  const blockers = uniqueMatchingLines(relevant, BLOCKER_PATTERNS);
  const ideas = uniqueMatchingLines(relevant, IDEA_PATTERNS);
  const openQuestions = relevant
    .flatMap((message) => message.content.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?") || line.endsWith("？"))
    .slice(0, 20);
  const timelineEvents = buildTimeline(session, relevant, options);

  return {
    projectId,
    goals,
    currentState,
    decisions,
    openQuestions: uniqueNonEmpty(openQuestions),
    tasks,
    blockers,
    ideas,
    artifacts,
    timelineEvents,
    traces
  };
}

function extractDecisions(
  session: Session,
  messages: Message[],
  options: HeuristicExtractorOptions
): Decision[] {
  return messages
    .filter((message) => matchesAny(message.content, DECISION_PATTERNS))
    .slice(0, 20)
    .map((message) => {
      const line = bestLine(message.content, DECISION_PATTERNS);
      return {
        title: shortTitle(line),
        date: message.timestamp ?? new Date(session.updatedAt).toISOString(),
        decision: line,
        reason: "Heuristically extracted from transcript; user review required before merge.",
        sourceSessionId: session.id,
        traces: [traceForMessage(session, message, options.maxQuoteLength)]
      };
    });
}

function extractTasks(session: Session, messages: Message[], options: HeuristicExtractorOptions): Task[] {
  return messages
    .filter((message) => matchesAny(message.content, TASK_PATTERNS))
    .slice(0, 30)
    .map((message) => {
      const line = bestLine(message.content, TASK_PATTERNS);
      return {
        title: line.replace(/^[-*]\s*\[[ x]\]\s*/i, "").trim(),
        status: inferTaskStatus(line),
        sourceSessionId: session.id,
        traces: [traceForMessage(session, message, options.maxQuoteLength)]
      };
    });
}

function extractArtifacts(
  session: Session,
  messages: Message[],
  options: HeuristicExtractorOptions
): Artifact[] {
  const artifacts: Artifact[] = [];

  for (const message of messages) {
    const matches = message.content.match(new RegExp(ARTIFACT_PATTERNS[0], "gi")) ?? [];
    for (const pathOrUrl of matches.slice(0, 20)) {
      artifacts.push({
        type: inferArtifactType(pathOrUrl),
        pathOrUrl,
        description: `Referenced in ${session.provider} session ${session.id}`,
        sourceSessionId: session.id,
        traces: [traceForMessage(session, message, options.maxQuoteLength)]
      });
    }
  }

  return dedupeBy(artifacts, (artifact) => artifact.pathOrUrl).slice(0, 50);
}

function buildTimeline(
  session: Session,
  messages: Message[],
  options: HeuristicExtractorOptions
): TimelineEvent[] {
  const lastAssistant = messages.filter((message) => message.role === "assistant").at(-1);
  const source = lastAssistant ?? messages.at(-1);
  if (!source) {
    return [];
  }

  return [
    {
      title: session.title ?? `Session ${session.id}`,
      date: source.timestamp ?? new Date(session.updatedAt).toISOString(),
      description: shortTitle(source.content, 180),
      sourceSessionId: session.id,
      traces: [traceForMessage(session, source, options.maxQuoteLength)]
    }
  ];
}

function traceForMessage(session: Session, message: Message, maxQuoteLength: number): Trace {
  return {
    id: stableId("trace", `${session.id}:${message.id}:${message.lineNumber ?? ""}`),
    sessionId: session.id,
    provider: session.provider,
    sourcePath: session.sourcePath,
    messageRange: message.lineNumber ? [message.lineNumber, message.lineNumber] : undefined,
    messageIds: [message.id],
    timestamp: message.timestamp ?? new Date(session.updatedAt).toISOString(),
    quote: quoteForTrace(message.content, maxQuoteLength)
  };
}

function matchesAny(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

function firstMatchingLine(messages: Message[], patterns: RegExp[]): string | null {
  for (const message of messages) {
    const line = bestLine(message.content, patterns);
    if (line) {
      return line;
    }
  }
  return null;
}

function uniqueMatchingLines(messages: Message[], patterns: RegExp[]): string[] {
  return uniqueNonEmpty(
    messages
      .filter((message) => matchesAny(message.content, patterns))
      .map((message) => bestLine(message.content, patterns))
  ).slice(0, 20);
}

function bestLine(content: string, patterns: RegExp[]): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && matchesAny(line, patterns)) ?? shortTitle(content)
  );
}

function shortTitle(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function inferTaskStatus(line: string): Task["status"] {
  if (/\[[xX]\]|完成|done/i.test(line)) {
    return "done";
  }
  if (/blocked|阻塞|无法/i.test(line)) {
    return "blocked";
  }
  if (/doing|进行中|in progress/i.test(line)) {
    return "doing";
  }
  return "todo";
}

function inferArtifactType(pathOrUrl: string): Artifact["type"] {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return "link";
  }
  if (/\.(ts|tsx|js|py|rs|go|java|kt)$/i.test(pathOrUrl)) {
    return "code";
  }
  if (/\.(md|txt|docx|pdf)$/i.test(pathOrUrl)) {
    return "doc";
  }
  return "file";
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function dedupeBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
