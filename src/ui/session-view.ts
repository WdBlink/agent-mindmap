import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type AgentMindmapPlugin from "../main";
import type { Message, OperationDiagnostic, Session, SessionStatus } from "../types";
import { DEFAULT_FILTERS, countSessions, diagnosticSummary, filterSessions, recoveryLabels, type SessionFilters } from "./view-model";

export const VIEW_TYPE_AGENT_MINDMAP = "agent-mindmap-sessions";

export class AgentMindmapView extends ItemView {
  private filters: SessionFilters = { ...DEFAULT_FILTERS };
  private selectedSessionId: string | null = null;
  private activeTab: "Summary" | "Transcript" | "Memory" | "Evidence" | "Activity" = "Summary";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AgentMindmapPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT_MINDMAP;
  }

  getDisplayText(): string {
    return "AI Sessions";
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("agent-mindmap-view");

    const state = this.plugin.getViewState();
    const visibleSessions = filterSessions(state.sessions, this.filters);
    const selected = visibleSessions.find((session) => session.id === this.selectedSessionId) ?? visibleSessions[0] ?? null;
    this.selectedSessionId = selected?.id ?? null;

    this.renderNavigator(container.createDiv("agent-mindmap-navigator"), state.sessions, state.diagnostics);
    this.renderInbox(container.createDiv("agent-mindmap-inbox"), visibleSessions, state.loading);
    this.renderInspector(container.createDiv("agent-mindmap-inspector"), selected, state.diagnostics);
  }

  private renderNavigator(container: HTMLElement, sessions: Session[], diagnostics: OperationDiagnostic[]): void {
    const counts = countSessions(sessions);
    container.createEl("h3", { text: "Sources" });
    this.renderFilterRow(container, "All", counts.total, () => {
      this.filters.provider = "all";
      this.render();
    }, this.filters.provider === "all");
    this.renderFilterRow(container, "Codex", counts.byProvider.codex, () => {
      this.filters.provider = "codex";
      this.render();
    }, this.filters.provider === "codex");
    this.renderFilterRow(container, "Claude Code", counts.byProvider["claude-code"], () => {
      this.filters.provider = "claude-code";
      this.render();
    }, this.filters.provider === "claude-code");

    container.createEl("h3", { text: "Status" });
    this.renderFilterRow(container, "All status", sessions.length, () => {
      this.filters.status = "all";
      this.render();
    }, this.filters.status === "all");
    (["new", "reviewed", "merged", "ignored"] as SessionStatus[]).forEach((status) => {
      this.renderFilterRow(container, status, counts.byStatus[status], () => {
        this.filters.status = status;
        this.render();
      }, this.filters.status === status);
    });

    container.createEl("h3", { text: "Projects" });
    this.renderFilterRow(container, "All projects", sessions.length, () => {
      this.filters.projectId = "all";
      this.render();
    }, this.filters.projectId === "all");
    this.renderFilterRow(container, "Unmapped", counts.unmapped, () => {
      this.filters.projectId = "unmapped";
      this.render();
    }, this.filters.projectId === "unmapped");
    for (const projectId of Array.from(new Set(sessions.map((session) => session.projectId).filter(Boolean) as string[])).slice(0, 8)) {
      this.renderFilterRow(container, projectId, sessions.filter((session) => session.projectId === projectId).length, () => {
        this.filters.projectId = projectId;
        this.render();
      }, this.filters.projectId === projectId);
    }

    container.createEl("h3", { text: "Health" });
    if (!diagnostics.length) {
      container.createDiv("agent-mindmap-muted").setText("No diagnostics.");
      return;
    }
    diagnostics.slice(0, 5).forEach((diagnostic) => {
      const row = container.createDiv(`agent-mindmap-health agent-mindmap-${diagnostic.severity}`);
      row.createEl("span", { text: diagnosticSummary(diagnostic) });
      row.createEl("small", { text: diagnostic.recoveryActionLabel });
    });
  }

  private renderInbox(container: HTMLElement, sessions: Session[], loading: boolean): void {
    const header = container.createDiv("agent-mindmap-panel-header");
    header.createEl("h2", { text: "Session Inbox" });
    const refresh = header.createEl("button", { text: "Refresh" });
    refresh.addEventListener("click", () => void this.refresh());

    const search = container.createEl("input", {
      type: "search",
      placeholder: "Search title, prompt, cwd, path"
    });
    search.value = this.filters.search;
    search.addEventListener("input", () => {
      this.filters.search = search.value;
      this.render();
    });

    if (loading) {
      this.renderSkeleton(container, 5);
      return;
    }
    if (!sessions.length) {
      const empty = container.createDiv("agent-mindmap-empty");
      empty.createEl("strong", { text: "No sessions found" });
      empty.createEl("p", { text: "Check source paths or run Refresh Sessions." });
      return;
    }

    const list = container.createDiv("agent-mindmap-session-list");
    sessions.forEach((session) => {
      const row = list.createDiv({
        cls: `agent-mindmap-session-row ${session.id === this.selectedSessionId ? "is-selected" : ""}`
      });
      row.tabIndex = 0;
      row.addEventListener("click", () => {
        this.selectedSessionId = session.id;
        this.render();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          this.selectedSessionId = session.id;
          this.render();
        }
      });
      const meta = row.createDiv("agent-mindmap-row-meta");
      meta.createEl("span", { text: session.provider });
      meta.createEl("span", { text: session.projectId ?? "Unmapped" });
      meta.createEl("span", { text: session.status });
      row.createEl("strong", { text: session.title ?? session.lastPrompt ?? session.id });
      row.createEl("small", { text: `${session.projectPath ?? session.sourcePath} · ${session.rounds} rounds · ${session.messageCount} messages` });
    });
  }

  private renderInspector(
    container: HTMLElement,
    session: Session | null,
    diagnostics: OperationDiagnostic[]
  ): void {
    container.createEl("h2", { text: "Session / Project Inspector" });
    if (!session) {
      const empty = container.createDiv("agent-mindmap-empty");
      empty.createEl("strong", { text: "Nothing selected" });
      empty.createEl("p", { text: "Select a session to inspect summary, transcript, memory, evidence, and activity." });
      return;
    }

    container.createEl("small", { text: `${session.provider} / ${session.projectId ?? "Unmapped"} / ${session.status}` });
    container.createEl("h3", { text: session.title ?? session.id });
    container.createEl("p", { text: session.summary ?? session.lastPrompt ?? "No summary extracted yet." });
    container.createEl("code", { text: session.projectPath ?? session.sourcePath });

    const actions = container.createDiv("agent-mindmap-actions");
    this.actionButton(actions, "Map to Project", () => {
      const project = this.plugin.mapSessionToProject(session.id);
      new Notice(project ? `Mapped to ${project.name}.` : "Could not map selected session.");
      this.render();
    });
    this.actionButton(actions, "Extract Memory", () => void this.extractSelected(session.id));
    this.actionButton(actions, "Confirm Apply", () => void this.applyConfirmed());
    this.actionButton(actions, "Generate Canvas", () => void this.plugin.generateCanvasFromLastPreview());

    const tabs = container.createDiv("agent-mindmap-tabs");
    (["Summary", "Transcript", "Memory", "Evidence", "Activity"] as const).forEach((name) => {
      const tab = tabs.createEl("button", { text: name, cls: name === this.activeTab ? "is-active" : "" });
      tab.addEventListener("click", () => {
        this.activeTab = name;
        if (name === "Transcript") {
          void this.loadTranscript(session.id);
        }
        this.render();
      });
    });
    this.renderTabPanel(container.createDiv("agent-mindmap-tab-panel"), session);

    const recovery = recoveryLabels(diagnostics);
    if (recovery.length) {
      const block = container.createDiv("agent-mindmap-error-state");
      block.createEl("strong", { text: "Recovery actions" });
      recovery.forEach((label) => {
        const button = block.createEl("button", { text: label });
        button.addEventListener("click", () => {
          if (label === "Run Refresh Sessions") {
            void this.refresh();
          } else if (label === "Check source path") {
            new Notice("Open Agent Mindmap settings to update source paths.");
          } else {
            new Notice(label);
          }
        });
      });
    }
  }

  private renderTabPanel(container: HTMLElement, session: Session): void {
    const workflow = this.plugin.getViewState().mergeWorkflow;
    if (this.activeTab === "Summary") {
      container.createEl("p", { text: session.summary ?? session.lastPrompt ?? "No summary extracted yet." });
      return;
    }
    if (this.activeTab === "Transcript") {
      const messages: Message[] = this.plugin.getViewState().transcriptMessages[session.id] ?? [];
      if (messages.length) {
        const list = container.createEl("ul");
        messages.slice(0, 12).forEach((message) => {
          list.createEl("li", {
            text: `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 180)}`
          });
        });
        return;
      }
      container.createEl("p", { text: `Source transcript: ${session.sourcePath}` });
      const load = container.createEl("button", { text: "Load Transcript Preview" });
      load.addEventListener("click", () => void this.loadTranscript(session.id));
      return;
    }
    if (this.activeTab === "Memory") {
      if (!workflow.preview || workflow.selectedSessionId !== session.id) {
        container.createEl("p", { text: "No memory preview for this session. Run Extract Memory first." });
        return;
      }
      container.createEl("strong", { text: `Merge Review: ${workflow.status}` });
      const files = container.createEl("ul");
      Object.keys(workflow.preview.targetFiles).forEach((path) => files.createEl("li", { text: path }));
      if (workflow.preview.warnings.length) {
        container.createEl("p", { text: `Warnings: ${workflow.preview.warnings.join("; ")}` });
      }
      if (workflow.conflicts.length) {
        container.createEl("p", { text: `Conflicts: ${workflow.conflicts.map((conflict) => conflict.sourcePath).join(", ")}` });
      }
      return;
    }
    if (this.activeTab === "Evidence") {
      const traces = workflow.preview?.memory.traces ?? [];
      if (!traces.length || workflow.selectedSessionId !== session.id) {
        container.createEl("p", { text: "No evidence traces extracted for this session yet." });
        return;
      }
      const list = container.createEl("ul");
      traces.slice(0, 8).forEach((trace) => list.createEl("li", { text: `${trace.provider} ${trace.sessionId} ${trace.sourcePath}` }));
      return;
    }
    const activity = container.createEl("ul");
    activity.createEl("li", { text: `Selected session: ${session.id}` });
    activity.createEl("li", { text: `Merge status: ${workflow.status}` });
    if (workflow.appliedFiles.length) {
      activity.createEl("li", { text: `Applied files: ${workflow.appliedFiles.length}` });
    }
  }

  private renderFilterRow(
    container: HTMLElement,
    label: string,
    count: number,
    onClick: () => void,
    active: boolean
  ): void {
    const row = container.createEl("button", { cls: `agent-mindmap-filter ${active ? "is-active" : ""}` });
    row.addEventListener("click", onClick);
    row.createEl("span", { text: label });
    row.createEl("small", { text: String(count) });
  }

  private renderSkeleton(container: HTMLElement, rows: number): void {
    for (let index = 0; index < rows; index += 1) {
      container.createDiv("agent-mindmap-skeleton");
    }
  }

  private actionButton(container: HTMLElement, label: string, onClick: () => void): void {
    const button = container.createEl("button", { text: label });
    button.addEventListener("click", onClick);
  }

  private async extractSelected(sessionId: string): Promise<void> {
    await this.plugin.extractLatestSessionPreview(sessionId);
    this.activeTab = "Memory";
    this.render();
  }

  private async applyConfirmed(): Promise<void> {
    await this.plugin.applyLastPreview({ confirmed: true });
    this.render();
  }

  private async loadTranscript(sessionId: string): Promise<void> {
    await this.plugin.loadTranscriptForSession(sessionId);
    this.render();
  }

  private async refresh(): Promise<void> {
    await this.plugin.scanSessions();
    this.render();
  }
}
