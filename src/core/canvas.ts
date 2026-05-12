import { stableId } from "./ids";
import type {
  CanvasEvidence,
  CanvasNodeKind,
  ExtractedProjectMemory,
  Project,
  ProjectCanvas,
  ProjectCanvasNode,
  Trace
} from "../types";

interface NodeSpec {
  id: string;
  kind: CanvasNodeKind;
  file: string;
  x: number;
  y: number;
  label: string;
  traces: Trace[];
}

export function generateProjectCanvas(project: Project, memory: ExtractedProjectMemory): ProjectCanvas {
  if (!project.id || !memory.projectId || project.id !== memory.projectId) {
    throw new Error("Canvas generation requires a matching projectId; single-session canvas output is not allowed.");
  }

  const fallbackTraces = memory.traces.slice(0, 5);
  const specs: NodeSpec[] = [
    {
      id: "goal",
      kind: "project-goal",
      file: relativeProjectFile(project, "project-state.md"),
      x: 0,
      y: 0,
      label: "Project Goal",
      traces: fallbackTraces
    },
    {
      id: "state",
      kind: "current-state",
      file: relativeProjectFile(project, "project-state.md"),
      x: 0,
      y: 280,
      label: "Current State",
      traces: fallbackTraces
    },
    {
      id: "decisions",
      kind: "decision",
      file: relativeProjectFile(project, "decisions.md"),
      x: -460,
      y: 280,
      label: "Decisions",
      traces: memory.decisions.flatMap((decision) => decision.traces).slice(0, 8)
    },
    {
      id: "open-loops",
      kind: "open-loop",
      file: relativeProjectFile(project, "open-loops.md"),
      x: 460,
      y: 280,
      label: "Open Loops",
      traces: fallbackTraces
    },
    {
      id: "tasks",
      kind: "next-task",
      file: relativeProjectFile(project, "tasks.md"),
      x: 0,
      y: 560,
      label: "Next Tasks",
      traces: memory.tasks.flatMap((task) => task.traces).slice(0, 8)
    },
    {
      id: "artifacts",
      kind: "artifact",
      file: relativeProjectFile(project, "artifacts.md"),
      x: -460,
      y: 560,
      label: "Artifacts",
      traces: memory.artifacts.flatMap((artifact) => artifact.traces).slice(0, 8)
    },
    {
      id: "risks",
      kind: "risk",
      file: relativeProjectFile(project, "open-loops.md"),
      x: 460,
      y: 560,
      label: "Risks",
      traces: fallbackTraces
    }
  ];

  const nodes = specs.map((spec) => nodeFromSpec(project.id, spec, fallbackTraces));
  const edges = [
    edge(project.id, "goal", "state"),
    edge(project.id, "goal", "decisions"),
    edge(project.id, "goal", "open-loops"),
    edge(project.id, "state", "tasks"),
    edge(project.id, "state", "artifacts"),
    edge(project.id, "open-loops", "risks")
  ];

  return { nodes, edges };
}

export function serializeCanvas(canvas: ProjectCanvas): string {
  return `${JSON.stringify(canvas, null, "\t")}\n`;
}

export function parseCanvas(content: string): ProjectCanvas {
  const parsed = JSON.parse(content) as ProjectCanvas;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("Canvas file must contain nodes and edges arrays.");
  }
  return parsed;
}

export function mergeGeneratedCanvas(existing: ProjectCanvas | null, generated: ProjectCanvas): ProjectCanvas {
  if (!existing) {
    return generated;
  }

  const generatedIds = new Set(generated.nodes.map((node) => node.id));
  const preservedNodes = existing.nodes.filter((node) => !generatedIds.has(node.id));
  const preservedEdges = existing.edges.filter(
    (edge) => !generatedIds.has(edge.fromNode) && !generatedIds.has(edge.toNode)
  );

  return {
    nodes: [...generated.nodes, ...preservedNodes],
    edges: [...generated.edges, ...preservedEdges]
  };
}

function nodeFromSpec(projectId: string, spec: NodeSpec, fallbackTraces: Trace[]): ProjectCanvasNode {
  const evidence = tracesToEvidence(spec.traces.length ? spec.traces : fallbackTraces);
  return {
    id: stableId("node", `${projectId}:${spec.id}`),
    type: "file",
    file: spec.file,
    text: spec.label,
    x: spec.x,
    y: spec.y,
    width: 360,
    height: 220,
    projectId,
    nodeKind: spec.kind,
    evidence
  };
}

function edge(projectId: string, from: string, to: string) {
  return {
    id: stableId("edge", `${projectId}:${from}:${to}`),
    fromNode: stableId("node", `${projectId}:${from}`),
    fromSide: "bottom" as const,
    toNode: stableId("node", `${projectId}:${to}`),
    toSide: "top" as const
  };
}

function tracesToEvidence(traces: Trace[]): CanvasEvidence[] {
  return traces.map((trace) => ({
    traceId: trace.id,
    sessionId: trace.sessionId,
    provider: trace.provider,
    sourcePath: trace.sourcePath,
    messageRange: trace.messageRange,
    messageIds: trace.messageIds,
    timestamp: trace.timestamp,
    excerpt: trace.quote
  }));
}

function relativeProjectFile(project: Project, file: string): string {
  return `${project.vaultPath}/${file}`;
}
