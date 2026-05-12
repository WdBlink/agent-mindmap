import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { generateProjectCanvas, mergeGeneratedCanvas, parseCanvas, serializeCanvas } from "../src/core/canvas";
import { extractProjectMemoryHeuristic } from "../src/core/extractor";
import { applyManualMerge, planManualMerge } from "../src/core/merge";
import { SessionService } from "../src/core/session-service";
import { DEFAULT_SETTINGS } from "../src/settings";
import { DEFAULT_FILTERS, filterSessions, recoveryLabels } from "../src/ui/view-model";
import type { ExtractedProjectMemory, Message, Project, Session, Trace } from "../src/types";
import { SessionCache, type StoragePort } from "../src/core/storage";

class MemoryStorage implements StoragePort {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`Missing file ${path}`);
    }
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
}

const session: Session = {
  id: "s1",
  provider: "codex",
  sourcePath: "/tmp/session.jsonl",
  projectPath: "/repo/demo",
  projectId: null,
  title: "demo",
  summary: "目标：构建项目记忆插件",
  lastPrompt: "请实现 adapter 和 Canvas",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 2,
  rounds: 1,
  status: "new"
};

const project: Project = {
  id: "project-demo",
  name: "demo",
  rootPath: "/repo/demo",
  vaultPath: "AI-Projects/Projects/demo",
  aliases: ["demo"],
  sessionIds: ["s1"],
  stateFile: "AI-Projects/Projects/demo/project-state.md",
  canvasFile: "AI-Projects/Projects/demo/map.canvas",
  createdAt: 1,
  updatedAt: 2
};

describe("core MVP behavior", () => {
  it("extracts project memory with trace evidence", () => {
    const messages: Message[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        content: "决定：Markdown/JSON 是状态源，Canvas 只是展示层。\n实现 src/main.ts",
        timestamp: "2026-05-12T00:00:00.000Z",
        lineNumber: 10
      }
    ];

    const memory = extractProjectMemoryHeuristic(session, messages, project.id, { maxQuoteLength: 120 });

    expect(memory.projectId).toBe(project.id);
    expect(memory.decisions[0]?.traces[0]?.sourcePath).toBe("/tmp/session.jsonl");
    expect(memory.artifacts.some((artifact) => artifact.pathOrUrl === "src/main.ts")).toBe(true);
  });

  it("plans manual merge without writing until apply is confirmed", async () => {
    const trace: Trace = {
      id: "trace-1",
      sessionId: "s1",
      provider: "codex",
      sourcePath: "/tmp/session.jsonl",
      timestamp: "2026-05-12T00:00:00.000Z",
      quote: "决定：手动合并"
    };
    const memory = minimalMemory([trace]);
    const preview = planManualMerge(project, memory);
    const storage = new MemoryStorage();

    const skipped = await applyManualMerge(storage, preview, { confirmed: false });
    expect(skipped.writtenFiles).toHaveLength(0);
    expect(storage.files.size).toBe(0);

    const applied = await applyManualMerge(storage, preview, { confirmed: true });
    expect(applied.writtenFiles).toContain(project.stateFile);
    expect(storage.files.get(project.stateFile)).toContain("Evidence");
  });

  it("does not overwrite user-maintained Markdown during manual merge", async () => {
    const memory = minimalMemory([
      {
        id: "trace-1",
        sessionId: "s1",
        provider: "codex",
        sourcePath: "/tmp/session.jsonl",
        timestamp: "2026-05-12T00:00:00.000Z"
      }
    ]);
    const preview = planManualMerge(project, memory);
    const storage = new MemoryStorage();
    await storage.write(project.stateFile, "# User maintained state\n");

    const result = await applyManualMerge(storage, preview, { confirmed: true });

    expect(result.conflicts).toHaveLength(1);
    expect(result.writtenFiles).not.toContain(project.stateFile);
    expect(await storage.read(project.stateFile)).toBe("# User maintained state\n");
  });

  it("does not overwrite stale generated Markdown with user edits", async () => {
    const memory = minimalMemory([
      {
        id: "trace-1",
        sessionId: "s1",
        provider: "codex",
        sourcePath: "/tmp/session.jsonl",
        timestamp: "2026-05-12T00:00:00.000Z"
      }
    ]);
    const preview = planManualMerge(project, memory);
    const storage = new MemoryStorage();
    await storage.write(project.stateFile, `${preview.targetFiles[project.stateFile]}\nUser note after generation.\n`);

    const result = await applyManualMerge(storage, preview, { confirmed: true });

    expect(result.conflicts.map((conflict) => conflict.sourcePath)).toContain(project.stateFile);
    expect(result.writtenFiles).not.toContain(project.stateFile);
    expect(await storage.read(project.stateFile)).toContain("User note after generation.");
  });

  it("requires project-scoped Canvas generation and carries evidence", () => {
    const trace: Trace = {
      id: "trace-1",
      sessionId: "s1",
      provider: "codex",
      sourcePath: "/tmp/session.jsonl",
      timestamp: "2026-05-12T00:00:00.000Z",
      quote: "目标"
    };
    const memory = minimalMemory([trace]);
    const canvas = generateProjectCanvas(project, memory);

    expect(canvas.nodes.every((node) => node.projectId === project.id)).toBe(true);
    expect(canvas.nodes.every((node) => node.evidence.length > 0)).toBe(true);
    const parsed = parseCanvas(serializeCanvas(canvas));
    expect(parsed.nodes.every((node) => node.type !== "file" || node.file?.endsWith(".md"))).toBe(true);
    expect(parsed.nodes.every((node) => node.evidence.every((item) => item.sessionId && item.sourcePath))).toBe(true);
    expect(() => generateProjectCanvas(project, { ...memory, projectId: "other" })).toThrow(/projectId/);
  });

  it("preserves manual Canvas nodes during generated updates", () => {
    const memory = minimalMemory([
      {
        id: "trace-1",
        sessionId: "s1",
        provider: "codex",
        sourcePath: "/tmp/session.jsonl",
        timestamp: "2026-05-12T00:00:00.000Z"
      }
    ]);
    const generated = generateProjectCanvas(project, memory);
    const merged = mergeGeneratedCanvas(
      {
        nodes: [
          ...generated.nodes,
          {
            id: "manual-note",
            type: "text",
            text: "User note",
            x: 1000,
            y: 1000,
            width: 300,
            height: 160,
            projectId: project.id,
            nodeKind: "current-state",
            evidence: []
          }
        ],
        edges: []
      },
      generated
    );

    expect(merged.nodes.some((node) => node.id === "manual-note")).toBe(true);
  });

  it("returns scan diagnostics while keeping healthy provider sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-"));
    const codexRoot = join(root, "codex");
    const cacheStorage = new MemoryStorage();
    await mkdir(codexRoot, { recursive: true });
    await writeFile(
      join(codexRoot, "rollout-2026-05-12T00-00-00-abc.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd: "/repo/demo" } }),
        "{not-json",
        JSON.stringify({ type: "event_msg", payload: { message: "user: implement adapter" } })
      ].join("\n")
    );

    const service = new SessionService(
      {
        ...DEFAULT_SETTINGS,
        codexSessionRoots: [codexRoot],
        claudeProjectRoots: [join(root, "missing-claude")]
      },
      new SessionCache(cacheStorage, "cache/sessions-cache.json")
    );

    const result = await service.scanAllWithDiagnostics();

    expect(result.sessions.map((item) => item.id)).toContain("codex-session");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "parse-failed")).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "path-missing")).toBe(true);
  });

  it("reports empty directory diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-empty-"));
    const emptyRoot = join(root, "empty");
    await mkdir(emptyRoot, { recursive: true });
    const service = new SessionService(
      { ...DEFAULT_SETTINGS, codexSessionRoots: [emptyRoot], claudeProjectRoots: [] },
      new SessionCache(new MemoryStorage(), "cache/sessions-cache.json")
    );

    const result = await service.scanAllWithDiagnostics();

    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "empty-directory")).toBe(true);
  });

  it("filters inbox sessions by provider status project and search", () => {
    const sessions: Session[] = [
      { ...session, id: "codex-new", provider: "codex", status: "new", projectId: "project-demo", title: "Adapter work" },
      {
        ...session,
        id: "claude-merged",
        provider: "claude-code",
        status: "merged",
        projectId: null,
        title: "Canvas review",
        lastPrompt: "Review project map"
      }
    ];

    expect(filterSessions(sessions, { ...DEFAULT_FILTERS, provider: "codex" }).map((item) => item.id)).toEqual(["codex-new"]);
    expect(filterSessions(sessions, { ...DEFAULT_FILTERS, status: "merged" }).map((item) => item.id)).toEqual(["claude-merged"]);
    expect(filterSessions(sessions, { ...DEFAULT_FILTERS, projectId: "unmapped" }).map((item) => item.id)).toEqual(["claude-merged"]);
    expect(filterSessions(sessions, { ...DEFAULT_FILTERS, search: "adapter" }).map((item) => item.id)).toEqual(["codex-new"]);
  });

  it("keeps diagnostic recovery action labels available to the UI", () => {
    expect(
      recoveryLabels([
        {
          code: "path-missing",
          severity: "warning",
          message: "Missing",
          recoveryActionLabel: "Check source path"
        },
        {
          code: "parse-failed",
          severity: "warning",
          message: "Bad JSON",
          recoveryActionLabel: "Open source transcript"
        }
      ])
    ).toEqual(["Check source path", "Open source transcript"]);
  });

  it("supports selected-session map extract apply canvas workflow state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-workflow-"));
    const codexRoot = join(root, "codex");
    await mkdir(codexRoot, { recursive: true });
    const firstPath = join(codexRoot, "first.jsonl");
    const secondPath = join(codexRoot, "second.jsonl");
    await writeFile(
      firstPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "first", cwd: "/repo/first" } }),
        JSON.stringify({ type: "event_msg", payload: { message: "user: first session" } })
      ].join("\n")
    );
    await writeFile(
      secondPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "second", cwd: "/repo/second" } }),
        JSON.stringify({ type: "event_msg", payload: { message: "user: decide Canvas source" } })
      ].join("\n")
    );
    const storage = new MemoryStorage();
    const service = new SessionService(
      { ...DEFAULT_SETTINGS, codexSessionRoots: [codexRoot], claudeProjectRoots: [] },
      new SessionCache(storage, "cache/sessions-cache.json")
    );
    const result = await service.scanAllWithDiagnostics();
    const selected = result.sessions.find((item) => item.id === "second");

    expect(selected?.sourcePath).toBe(secondPath);
    expect(selected?.projectPath).toBe("/repo/second");
  });

  it("preserves cached session status and project mapping across scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-cache-"));
    const codexRoot = join(root, "codex");
    await mkdir(codexRoot, { recursive: true });
    const sessionPath = join(codexRoot, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "cached-session", cwd: "/repo/demo" } }),
        JSON.stringify({ type: "event_msg", payload: { message: "user: merge memory" } })
      ].join("\n")
    );
    const storage = new MemoryStorage();
    const cache = new SessionCache(storage, "cache/sessions-cache.json");
    const service = new SessionService(
      { ...DEFAULT_SETTINGS, codexSessionRoots: [codexRoot], claudeProjectRoots: [] },
      cache
    );
    const first = await service.scanAllWithDiagnostics();
    const cachedSession = { ...first.sessions[0], status: "merged" as const, projectId: "project-demo" };
    await service.saveSession(cachedSession);

    const second = await service.scanAllWithDiagnostics();

    expect(second.sessions[0]?.status).toBe("merged");
    expect(second.sessions[0]?.projectId).toBe("project-demo");
  });
});

function minimalMemory(traces: Trace[]): ExtractedProjectMemory {
  return {
    projectId: project.id,
    goals: ["构建 MVP"],
    currentState: ["核心模块完成"],
    decisions: [],
    openQuestions: [],
    tasks: [],
    blockers: [],
    ideas: [],
    artifacts: [],
    timelineEvents: [],
    traces
  };
}
