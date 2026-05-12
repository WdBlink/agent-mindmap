import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { generateProjectCanvas, mergeGeneratedCanvas, parseCanvas, serializeCanvas } from "../src/core/canvas";
import { extractProjectMemoryHeuristic } from "../src/core/extractor";
import { applyManualMerge, planManualMerge } from "../src/core/merge";
import { filterMessage } from "../src/core/privacy";
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

  it("parses rich Codex and Claude fixtures with diagnostics and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-rich-"));
    const codexRoot = join(root, "codex");
    const claudeRoot = join(root, "claude", "projects", "-Users-echooo-Repo-demo");
    await mkdir(codexRoot, { recursive: true });
    await mkdir(claudeRoot, { recursive: true });

    await writeFile(
      join(codexRoot, "rollout-2026-05-12T11-00-00-rich.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-rich", cwd: "/repo/codex-rich", title: "Codex Rich", timestamp: "2026-05-12T11:00:00.000Z" } }),
        JSON.stringify({ type: "response_item", payload: { item: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "目标：验证 rich Codex fixture" }] }, timestamp: "2026-05-12T11:01:00.000Z" } }),
        JSON.stringify({ type: "response_item", payload: { item: { type: "function_call", id: "tool1", name: "read_file", arguments: { path: "src/main.ts" } }, timestamp: "2026-05-12T11:02:00.000Z" } }),
        "{bad-json",
        JSON.stringify({ type: "response_item", payload: { item: { type: "function_call_output", id: "tool2", output: "implemented src/main.ts" }, timestamp: "2026-05-12T11:03:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { message: "user: 下一步：生成 map.canvas" }, timestamp: "2026-05-12T11:04:00.000Z" })
      ].join("\n")
    );
    await writeFile(
      join(claudeRoot, "claude-rich.jsonl"),
      [
        JSON.stringify({ sessionId: "claude-rich", customTitle: "Claude Rich", message: { role: "user", content: "目标：验证 Claude fixture" }, timestamp: "2026-05-12T11:05:00.000Z" }),
        JSON.stringify({ sessionId: "claude-rich", message: { role: "assistant", content: [{ type: "thinking", thinking: "分析" }, { type: "tool_use", name: "Edit", input: { file_path: "README.md" } }, { type: "tool_result", content: "完成 README.md" }] }, timestamp: "2026-05-12T11:06:00.000Z" })
      ].join("\n")
    );

    const service = new SessionService(
      { ...DEFAULT_SETTINGS, codexSessionRoots: [codexRoot], claudeProjectRoots: [join(root, "claude", "projects")] },
      new SessionCache(new MemoryStorage(), "cache/sessions-cache.json")
    );

    const result = await service.scanAllWithDiagnostics();
    const codex = result.sessions.find((item) => item.id === "codex-rich");
    const claude = result.sessions.find((item) => item.id === "claude-rich");

    expect(codex?.title).toBe("Codex Rich");
    expect(codex?.projectPath).toBe("/repo/codex-rich");
    expect(codex?.rounds).toBe(2);
    expect(claude?.title).toBe("Claude Rich");
    expect(claude?.projectPath).toBe("/Users/echooo/Repo/demo");
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "parse-failed")).toHaveLength(1);
    expect(codex ? (await service.parseMessages(codex)).some((message) => message.isTool) : false).toBe(true);
    expect(claude ? (await service.parseMessages(claude)).some((message) => message.isTool) : false).toBe(true);
  });

  it("redacts secrets without dropping legitimate tokenization content", () => {
    const legitimate = extractProjectMemoryHeuristic(
      session,
      [
        {
          id: "m-tokenization",
          sessionId: "s1",
          role: "user",
          content: "下一步：fix tokenization bug in src/tokenizer.ts",
          timestamp: "2026-05-12T00:00:00.000Z",
          lineNumber: 1
        },
        {
          id: "m-secret",
          sessionId: "s1",
          role: "assistant",
          content: "api_key=sk-real-secret token=abc123 Authorization: Bearer xyz password=hunter2 secret=value",
          timestamp: "2026-05-12T00:01:00.000Z",
          lineNumber: 2
        }
      ],
      project.id,
      { maxQuoteLength: 240 }
    );
    const serialized = JSON.stringify(legitimate);

    expect(serialized).toContain("tokenization");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("sk-real-secret");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("hunter2");
  });

  it("redacts structured tool input without dropping legitimate tokenization content", () => {
    const filtered = filterMessage(
      {
        id: "m-tool",
        sessionId: "s1",
        role: "tool",
        content: JSON.stringify({
          name: "request",
          arguments: {
            token: "abc123",
            nested: { password: "hunter2" },
            note: "fix tokenization bug"
          }
        }),
        timestamp: "2026-05-12T00:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            name: "request",
            input: {
              token: "abc123",
              nested: { password: "hunter2" },
              note: "fix tokenization bug"
            }
          }
        ]
      },
      { patterns: [], maxQuoteLength: 240 }
    );
    const serialized = JSON.stringify(filtered);

    expect(serialized).toContain("tokenization");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("hunter2");
  });

  it("does not treat same-size same-mtime transcript rewrites as fresh cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-samesize-"));
    const codexRoot = join(root, "codex");
    await mkdir(codexRoot, { recursive: true });
    const sessionPath = join(codexRoot, "session.jsonl");
    const firstContent = JSON.stringify({ type: "session_meta", payload: { id: "same-size", cwd: "/repo/aaaa" } });
    const secondContent = JSON.stringify({ type: "session_meta", payload: { id: "same-size", cwd: "/repo/bbbb" } });
    expect(secondContent.length).toBe(firstContent.length);

    await writeFile(sessionPath, firstContent);
    const storage = new MemoryStorage();
    const service = new SessionService(
      { ...DEFAULT_SETTINGS, codexSessionRoots: [codexRoot], claudeProjectRoots: [] },
      new SessionCache(storage, "cache/sessions-cache.json")
    );
    const first = await service.scanAllWithDiagnostics();
    await service.saveSession({ ...first.sessions[0], status: "merged", projectId: "project-old" });
    const originalStat = await stat(sessionPath);
    await writeFile(sessionPath, secondContent);
    await utimes(sessionPath, originalStat.atime, originalStat.mtime);

    const second = await service.scanAllWithDiagnostics();

    expect(second.sessions[0]?.projectPath).toBe("/repo/bbbb");
    expect(second.sessions[0]?.status).toBe("new");
    expect(second.sessions[0]?.projectId).toBeNull();
  });

  it("documents partial merge behavior when one target file conflicts", async () => {
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

    expect(result.conflicts.map((conflict) => conflict.sourcePath)).toEqual([project.stateFile]);
    expect(result.writtenFiles).toHaveLength(6);
    expect(await storage.read(project.stateFile)).toBe("# User maintained state\n");
  });

  it("keeps generated merge content stable for the same transcript evidence", async () => {
    const memory = minimalMemory([
      {
        id: "trace-1",
        sessionId: "s1",
        provider: "codex",
        sourcePath: "/tmp/session.jsonl",
        timestamp: "2026-05-12T00:00:00.000Z"
      }
    ]);
    const first = planManualMerge(project, memory);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = planManualMerge(project, memory);
    const storage = new MemoryStorage();

    await applyManualMerge(storage, first, { confirmed: true });
    const reapplied = await applyManualMerge(storage, second, { confirmed: true });

    expect(second.targetFiles).toEqual(first.targetFiles);
    expect(reapplied.conflicts).toHaveLength(0);
    expect(reapplied.writtenFiles).toHaveLength(7);
  });

  it("preserves manual canvas edges connected to generated nodes", () => {
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
    const manualNode = {
      id: "manual-note",
      type: "text" as const,
      text: "User note",
      x: 1000,
      y: 1000,
      width: 300,
      height: 160,
      projectId: project.id,
      nodeKind: "current-state" as const,
      evidence: []
    };
    const manualEdge = {
      id: "manual-to-generated",
      fromNode: manualNode.id,
      toNode: generated.nodes[0].id
    };
    const merged = mergeGeneratedCanvas(
      {
        nodes: [...generated.nodes, manualNode],
        edges: [...generated.edges, manualEdge]
      },
      generated
    );

    expect(merged.nodes.some((node) => node.id === manualNode.id)).toBe(true);
    expect(merged.edges.some((edge) => edge.id === manualEdge.id)).toBe(true);
  });

  it("leaves a corrupt existing canvas untouched and reports parse failure in the storage path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mindmap-corrupt-canvas-"));
    const file = join(root, "map.canvas");
    await writeFile(file, "{not-json");

    await expect(readFile(file, "utf8").then(parseCanvas)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{not-json");
    await rm(root, { recursive: true, force: true });
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
