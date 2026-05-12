export type Provider = "codex" | "claude-code" | "cursor" | "unknown";

export type SessionStatus = "new" | "reviewed" | "merged" | "ignored";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface OperationDiagnostic {
  provider?: Provider;
  sourcePath?: string;
  code:
    | "path-missing"
    | "empty-directory"
    | "permission-denied"
    | "parse-failed"
    | "provider-failed"
    | "extraction-gap"
    | "merge-conflict"
    | "canvas-update-failed"
    | "cache-stale";
  severity: DiagnosticSeverity;
  message: string;
  recoveryActionLabel: string;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string | null;
  vaultPath: string;
  aliases: string[];
  sessionIds: string[];
  stateFile: string;
  canvasFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  provider: Provider;
  sourcePath: string;
  projectPath: string | null;
  projectId: string | null;
  title: string | null;
  summary: string | null;
  lastPrompt: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  rounds: number;
  status: SessionStatus;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input?: unknown }
  | { type: "tool_result"; content: string };

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp: string | null;
  lineNumber?: number;
  isMeta?: boolean;
  isTool?: boolean;
  blocks?: ContentBlock[];
}

export interface Trace {
  id: string;
  sessionId: string;
  provider: Provider;
  sourcePath: string;
  messageRange?: [number, number];
  messageIds?: string[];
  timestamp: string;
  quote?: string;
}

export interface Decision {
  title: string;
  date: string;
  decision: string;
  reason: string;
  impact?: string;
  sourceSessionId: string;
  traces: Trace[];
}

export interface Task {
  title: string;
  status: "todo" | "doing" | "done" | "blocked";
  sourceSessionId: string;
  traces: Trace[];
}

export interface Artifact {
  type: "file" | "doc" | "code" | "link" | "command" | "other";
  pathOrUrl: string;
  description: string;
  sourceSessionId: string;
  traces: Trace[];
}

export interface TimelineEvent {
  title: string;
  date: string;
  description: string;
  sourceSessionId: string;
  traces: Trace[];
}

export interface ExtractedProjectMemory {
  projectId: string;
  goals: string[];
  currentState: string[];
  decisions: Decision[];
  openQuestions: string[];
  tasks: Task[];
  blockers: string[];
  ideas: string[];
  artifacts: Artifact[];
  timelineEvents: TimelineEvent[];
  traces: Trace[];
}

export interface CanvasEvidence {
  traceId: string;
  sessionId: string;
  provider: Provider;
  sourcePath: string;
  messageRange?: [number, number];
  messageIds?: string[];
  timestamp: string;
  excerpt?: string;
}

export type CanvasNodeKind =
  | "project-goal"
  | "current-state"
  | "decision"
  | "open-loop"
  | "next-task"
  | "artifact"
  | "risk";

export interface ProjectCanvasNode {
  id: string;
  type: "file" | "text";
  file?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  projectId: string;
  nodeKind: CanvasNodeKind;
  evidence: CanvasEvidence[];
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
}

export interface ProjectCanvas {
  nodes: ProjectCanvasNode[];
  edges: CanvasEdge[];
}

export interface SessionCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  session: Session;
}

export interface SessionCacheFile {
  version: 1;
  entries: Record<string, SessionCacheEntry>;
}

export interface MergePreview {
  project: Project;
  memory: ExtractedProjectMemory;
  targetFiles: Record<string, string>;
  generatedMarker: string;
  warnings: string[];
}

export interface ApplyMergeResult {
  writtenFiles: string[];
  conflicts: OperationDiagnostic[];
  warnings: string[];
}

export type MergeWorkflowStatus = "none" | "preview" | "applied" | "blocked";

export interface MergeWorkflowState {
  status: MergeWorkflowStatus;
  preview: MergePreview | null;
  selectedSessionId: string | null;
  appliedFiles: string[];
  conflicts: OperationDiagnostic[];
}
