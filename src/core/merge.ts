import type { ApplyMergeResult, ExtractedProjectMemory, MergePreview, OperationDiagnostic, Project, Trace } from "../types";
import type { StoragePort } from "./storage";

export const GENERATED_NOTICE = "<!-- agent-mindmap:generated; manual review required before applying -->";

export function planManualMerge(project: Project, memory: ExtractedProjectMemory): MergePreview {
  const warnings: string[] = [];
  if (!memory.projectId || memory.projectId !== project.id) {
    warnings.push("Extracted memory projectId does not match the target project.");
  }
  if (!hasTraceCoverage(memory)) {
    warnings.push("Some extracted memory has no trace evidence; review before applying.");
  }

  return {
    project,
    memory,
    targetFiles: {
      [project.stateFile]: renderProjectState(project, memory),
      [`${project.vaultPath}/timeline.md`]: renderTimeline(memory),
      [`${project.vaultPath}/decisions.md`]: renderDecisions(memory),
      [`${project.vaultPath}/open-loops.md`]: renderOpenLoops(memory),
      [`${project.vaultPath}/tasks.md`]: renderTasks(memory),
      [`${project.vaultPath}/ideas.md`]: renderIdeas(memory),
      [`${project.vaultPath}/artifacts.md`]: renderArtifacts(memory)
    },
    generatedMarker: GENERATED_NOTICE,
    warnings
  };
}

export async function applyManualMerge(
  storage: StoragePort,
  preview: MergePreview,
  options: { confirmed: boolean; overwriteConflicts?: boolean }
): Promise<ApplyMergeResult> {
  if (!options.confirmed) {
    return {
      writtenFiles: [],
      conflicts: [],
      warnings: [...preview.warnings, "Merge was not applied because confirmed=false."]
    };
  }

  const writtenFiles: string[] = [];
  const conflicts: OperationDiagnostic[] = [];
  for (const [path, content] of Object.entries(preview.targetFiles)) {
    if (!options.overwriteConflicts && (await storage.exists(path))) {
      const existing = await storage.read(path);
      if (existing.trim() && existing !== content) {
        conflicts.push({
          code: "merge-conflict",
          severity: "error",
          sourcePath: path,
          message: existing.includes(preview.generatedMarker)
            ? `${path} differs from this preview and was not overwritten. Open the target file to review user edits or regenerated content.`
            : `${path} already contains user-maintained content and was not overwritten.`,
          recoveryActionLabel: "Open target file"
        });
        continue;
      }
    }

    await storage.write(path, content);
    writtenFiles.push(path);
  }

  return {
    writtenFiles,
    conflicts,
    warnings: preview.warnings
  };
}

function renderProjectState(project: Project, memory: ExtractedProjectMemory): string {
  return [
    frontmatter(project, "project-state", generatedAt(memory, project.updatedAt)),
    GENERATED_NOTICE,
    `# ${project.name} Project State`,
    "",
    "## Goals",
    renderStringItems(memory.goals, memory.traces),
    "## Current State",
    renderStringItems(memory.currentState, memory.traces),
    "## Blockers",
    renderStringItems(memory.blockers, memory.traces),
    "## Evidence",
    renderTraces(memory.traces)
  ].join("\n");
}

function renderTimeline(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "timeline", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Timeline",
    "",
    ...memory.timelineEvents.flatMap((event) => [
      `## ${event.date}`,
      "",
      `- ${event.title}: ${event.description}`,
      renderInlineEvidence(event.traces),
      ""
    ])
  ].join("\n");
}

function renderDecisions(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "decisions", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Decisions",
    "",
    ...memory.decisions.flatMap((decision) => [
      `## ${decision.title}`,
      "",
      `- Date: ${decision.date}`,
      `- Decision: ${decision.decision}`,
      `- Reason: ${decision.reason}`,
      decision.impact ? `- Impact: ${decision.impact}` : "",
      renderInlineEvidence(decision.traces),
      ""
    ])
  ].join("\n");
}

function renderOpenLoops(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "open-loops", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Open Loops",
    "",
    "## Questions",
    renderStringItems(memory.openQuestions, memory.traces),
    "## Risks",
    renderStringItems(memory.blockers, memory.traces)
  ].join("\n");
}

function renderTasks(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "tasks", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Tasks",
    "",
    ...memory.tasks.map((task) => {
      const check = task.status === "done" ? "x" : " ";
      return `- [${check}] ${task.title} #${task.status}\n${renderInlineEvidence(task.traces)}`;
    })
  ].join("\n");
}

function renderIdeas(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "ideas", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Ideas",
    "",
    renderStringItems(memory.ideas, memory.traces)
  ].join("\n");
}

function renderArtifacts(memory: ExtractedProjectMemory): string {
  return [
    frontmatterByProject(memory.projectId, "artifacts", generatedAt(memory)),
    GENERATED_NOTICE,
    "# Artifacts",
    "",
    ...memory.artifacts.flatMap((artifact) => [
      `- ${artifact.pathOrUrl} (${artifact.type}) - ${artifact.description}`,
      renderInlineEvidence(artifact.traces)
    ])
  ].join("\n");
}

function frontmatter(project: Project, kind: string, updatedAt: string): string {
  return [
    "---",
    `projectId: ${JSON.stringify(project.id)}`,
    `projectName: ${JSON.stringify(project.name)}`,
    `kind: ${JSON.stringify(kind)}`,
    `updatedAt: ${JSON.stringify(updatedAt)}`,
    "---",
    ""
  ].join("\n");
}

function frontmatterByProject(projectId: string, kind: string, updatedAt: string): string {
  return [
    "---",
    `projectId: ${JSON.stringify(projectId)}`,
    `kind: ${JSON.stringify(kind)}`,
    `updatedAt: ${JSON.stringify(updatedAt)}`,
    "---",
    ""
  ].join("\n");
}

function generatedAt(memory: ExtractedProjectMemory, fallbackMs = 0): string {
  const timestamps = memory.traces
    .map((trace) => Date.parse(trace.timestamp))
    .filter((value) => Number.isFinite(value));
  const latest = timestamps.length ? Math.max(...timestamps) : fallbackMs;
  return new Date(latest || 0).toISOString();
}

function renderStringItems(items: string[], fallbackTraces: Trace[]): string {
  if (!items.length) {
    return "- _None extracted._\n";
  }
  const evidence = renderInlineEvidence(fallbackTraces.slice(0, 3));
  return `${items.map((item) => `- ${item}`).join("\n")}\n${evidence}\n`;
}

function renderInlineEvidence(traces: Trace[]): string {
  if (!traces.length) {
    return "<!-- Evidence: [] -->";
  }
  return `<!-- Evidence: ${JSON.stringify(traces.map(traceToEvidence))} -->`;
}

function renderTraces(traces: Trace[]): string {
  if (!traces.length) {
    return "- _No trace evidence available._\n";
  }
  return traces
    .map((trace) => {
      const range = trace.messageRange ? ` lines ${trace.messageRange[0]}-${trace.messageRange[1]}` : "";
      return `- ${trace.id}: ${trace.provider} ${trace.sessionId}${range} ${trace.sourcePath}\n  - Quote: ${trace.quote ?? ""}`;
    })
    .join("\n");
}

function traceToEvidence(trace: Trace): Record<string, unknown> {
  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    provider: trace.provider,
    sourcePath: trace.sourcePath,
    messageRange: trace.messageRange,
    messageIds: trace.messageIds,
    timestamp: trace.timestamp,
    excerpt: trace.quote
  };
}

function hasTraceCoverage(memory: ExtractedProjectMemory): boolean {
  const traceCount = memory.traces.length;
  const nested = [
    ...memory.decisions.flatMap((decision) => decision.traces),
    ...memory.tasks.flatMap((task) => task.traces),
    ...memory.artifacts.flatMap((artifact) => artifact.traces),
    ...memory.timelineEvents.flatMap((event) => event.traces)
  ];
  return traceCount > 0 && nested.every((trace) => Boolean(trace.id));
}
