import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { serializeCanvas, generateProjectCanvas, mergeGeneratedCanvas, parseCanvas } from "./core/canvas";
import { extractProjectMemoryHeuristic } from "./core/extractor";
import { applyManualMerge, planManualMerge } from "./core/merge";
import { mapSessionToProject } from "./core/project-mapping";
import { SessionService } from "./core/session-service";
import { ObsidianVaultStorage, SessionCache } from "./core/storage";
import { DEFAULT_SETTINGS, normalizeSettings, type AgentMindmapSettings } from "./settings";
import { AgentMindmapView, VIEW_TYPE_AGENT_MINDMAP } from "./ui/session-view";
import type { MergeWorkflowState, Message, OperationDiagnostic, Project, Session } from "./types";

export default class AgentMindmapPlugin extends Plugin {
  settings: AgentMindmapSettings = DEFAULT_SETTINGS;
  private lastSessions: Session[] = [];
  private transcriptMessages: Record<string, Message[]> = {};
  lastDiagnostics: OperationDiagnostic[] = [];
  private loading = false;
  private mergeWorkflow: MergeWorkflowState = {
    status: "none",
    preview: null,
    selectedSessionId: null,
    appliedFiles: [],
    conflicts: []
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AgentMindmapSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_AGENT_MINDMAP, (leaf: WorkspaceLeaf) => new AgentMindmapView(leaf, this));
    this.addRibbonIcon("network", "Open AI Sessions", () => void this.activateView());

    this.addCommand({
      id: "open-ai-sessions-view",
      name: "Open AI Sessions view",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "scan-ai-sessions",
      name: "Scan Codex and Claude Code sessions",
      callback: () => void this.scanSessions()
    });

    this.addCommand({
      id: "extract-latest-session-preview",
      name: "Extract latest session into manual merge preview",
      callback: () => void this.extractLatestSessionPreview()
    });

    this.addCommand({
      id: "apply-last-manual-merge",
      name: "Apply last manual merge preview",
      callback: () => void this.applyLastPreview()
    });

    this.addCommand({
      id: "generate-project-canvas-from-last-preview",
      name: "Generate project Canvas from last preview",
      callback: () => void this.generateCanvasFromLastPreview()
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGENT_MINDMAP);
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings((await this.loadData()) as Partial<AgentMindmapSettings> | undefined);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private sessionService(): SessionService {
    const storage = new ObsidianVaultStorage(this.app.vault.adapter);
    const cache = new SessionCache(storage, `${this.settings.memoryRoot}/_cache/sessions-cache.json`);
    return new SessionService(this.settings, cache);
  }

  getViewState(): {
    sessions: Session[];
    transcriptMessages: Record<string, Message[]>;
    diagnostics: OperationDiagnostic[];
    loading: boolean;
    mergeWorkflow: MergeWorkflowState;
  } {
    return {
      sessions: this.lastSessions,
      transcriptMessages: this.transcriptMessages,
      diagnostics: this.lastDiagnostics,
      loading: this.loading,
      mergeWorkflow: this.mergeWorkflow
    };
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_MINDMAP);
    const leaf = leaves[0] ?? this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE_AGENT_MINDMAP, active: true });
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async scanSessions(): Promise<void> {
    this.loading = true;
    try {
      const result = await this.sessionService().scanAllWithDiagnostics();
      this.lastSessions = result.sessions;
      this.lastDiagnostics = result.diagnostics;
      const suffix = result.diagnostics.length ? ` ${result.diagnostics.length} diagnostics need review.` : "";
      new Notice(`Agent Mindmap: found ${result.sessions.length} AI sessions.${suffix}`);
    } catch (error) {
      new Notice(`Agent Mindmap: scan failed. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.loading = false;
    }
  }

  mapSessionToProject(sessionId: string): Project | null {
    const session = this.lastSessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return null;
    }
    const project = mapSessionToProject(session, { memoryRoot: this.settings.memoryRoot });
    session.projectId = project.id;
    void this.sessionService().saveSession(session);
    return project;
  }

  async extractLatestSessionPreview(sessionId?: string): Promise<void> {
    const sessions = this.lastSessions.length ? this.lastSessions : (await this.sessionService().scanAllWithDiagnostics()).sessions;
    const session = sessionId ? sessions.find((candidate) => candidate.id === sessionId) : sessions[0];
    if (!session) {
      new Notice("Agent Mindmap: no Codex or Claude Code sessions found.");
      return;
    }

    try {
      const service = this.sessionService();
      const messages = await service.parseMessages(session);
      this.transcriptMessages = { ...this.transcriptMessages, [session.id]: messages };
      const project = this.mapSessionToProject(session.id) ?? mapSessionToProject(session, { memoryRoot: this.settings.memoryRoot });
      const memory = extractProjectMemoryHeuristic(session, messages, project.id, {
        maxQuoteLength: this.settings.maxQuoteLength
      });
      const preview = planManualMerge(project, memory);
      const warningDiagnostics: OperationDiagnostic[] = preview.warnings.map((warning) => ({
        provider: session.provider,
        sourcePath: session.sourcePath,
        code: "extraction-gap",
        severity: "warning",
        message: warning,
        recoveryActionLabel: "Review merge preview"
      }));
      if (warningDiagnostics.length) {
        this.lastDiagnostics = [...this.lastDiagnostics, ...warningDiagnostics];
      }
      this.mergeWorkflow = {
        status: "preview",
        preview,
        selectedSessionId: session.id,
        appliedFiles: [],
        conflicts: []
      };
      session.status = "reviewed";
      await service.saveSession(session);

      const storage = new ObsidianVaultStorage(this.app.vault.adapter);
      const previewPath = `${this.settings.memoryRoot}/_inbox/merge-preview-${session.id}.json`;
      await storage.write(previewPath, `${JSON.stringify(preview, null, 2)}\n`);
      new Notice(`Agent Mindmap: wrote manual merge preview for ${project.name}.`);
    } catch (error) {
      new Notice(`Agent Mindmap: extraction failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadTranscriptForSession(sessionId: string): Promise<void> {
    const session = this.lastSessions.find((candidate) => candidate.id === sessionId);
    if (!session || this.transcriptMessages[session.id]) {
      return;
    }
    try {
      const messages = await this.sessionService().parseMessages(session);
      this.transcriptMessages = { ...this.transcriptMessages, [session.id]: messages };
    } catch (error) {
      this.lastDiagnostics = [
        ...this.lastDiagnostics,
        {
          provider: session.provider,
          sourcePath: session.sourcePath,
          code: "parse-failed",
          severity: "error",
          message: `Transcript preview failed: ${error instanceof Error ? error.message : String(error)}.`,
          recoveryActionLabel: "Open source transcript"
        }
      ];
    }
  }

  async applyLastPreview(options: { confirmed?: boolean } = {}): Promise<void> {
    if (!this.mergeWorkflow.preview) {
      new Notice("Agent Mindmap: no merge preview in memory. Run extract preview first.");
      return;
    }
    const storage = new ObsidianVaultStorage(this.app.vault.adapter);
    const result = await applyManualMerge(storage, this.mergeWorkflow.preview, { confirmed: options.confirmed === true });
    this.mergeWorkflow = {
      ...this.mergeWorkflow,
      status: result.conflicts.length ? "blocked" : result.writtenFiles.length ? "applied" : "preview",
      appliedFiles: result.writtenFiles,
      conflicts: result.conflicts
    };
    if (!result.conflicts.length && result.writtenFiles.length && this.mergeWorkflow.selectedSessionId) {
      const session = this.lastSessions.find((candidate) => candidate.id === this.mergeWorkflow.selectedSessionId);
      if (session) {
        session.status = "merged";
        await this.sessionService().saveSession(session);
      }
    }
    this.lastDiagnostics = [...this.lastDiagnostics, ...result.conflicts];
    const conflictSuffix = result.conflicts.length ? ` ${result.conflicts.length} conflicts skipped.` : "";
    new Notice(`Agent Mindmap: applied ${result.writtenFiles.length} Markdown files.${conflictSuffix}`);
  }

  async generateCanvasFromLastPreview(): Promise<void> {
    if (!this.mergeWorkflow.preview) {
      new Notice("Agent Mindmap: no merge preview in memory. Run extract preview first.");
      return;
    }
    if (this.mergeWorkflow.status !== "applied") {
      new Notice("Agent Mindmap: review and apply the merge before generating Canvas.");
      return;
    }
    try {
      const generated = generateProjectCanvas(this.mergeWorkflow.preview.project, this.mergeWorkflow.preview.memory);
      const storage = new ObsidianVaultStorage(this.app.vault.adapter);
      const existing = (await storage.exists(this.mergeWorkflow.preview.project.canvasFile))
        ? parseCanvas(await storage.read(this.mergeWorkflow.preview.project.canvasFile))
        : null;
      const canvas = mergeGeneratedCanvas(existing, generated);
      await storage.write(this.mergeWorkflow.preview.project.canvasFile, serializeCanvas(canvas));
      new Notice(`Agent Mindmap: generated Canvas for ${this.mergeWorkflow.preview.project.name}.`);
    } catch (error) {
      this.lastDiagnostics = [
        ...this.lastDiagnostics,
        {
          code: "canvas-update-failed",
          severity: "error",
          sourcePath: this.mergeWorkflow.preview.project.canvasFile,
          message: `Canvas update failed: ${error instanceof Error ? error.message : String(error)}.`,
          recoveryActionLabel: "Open target file"
        }
      ];
      new Notice(`Agent Mindmap: Canvas update failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class AgentMindmapSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgentMindmapPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Agent Mindmap" });

    new Setting(containerEl)
      .setName("Memory root")
      .setDesc("Vault-relative folder for Markdown, JSON cache, and project Canvas files.")
      .addText((text) =>
        text.setValue(this.plugin.settings.memoryRoot).onChange(async (value) => {
          this.plugin.settings.memoryRoot = value.trim() || DEFAULT_SETTINGS.memoryRoot;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Codex session roots")
      .setDesc("One path per line.")
      .addTextArea((text) =>
        text.setValue(this.plugin.settings.codexSessionRoots.join("\n")).onChange(async (value) => {
          this.plugin.settings.codexSessionRoots = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Claude Code project roots")
      .setDesc("One path per line.")
      .addTextArea((text) =>
        text.setValue(this.plugin.settings.claudeProjectRoots.join("\n")).onChange(async (value) => {
          this.plugin.settings.claudeProjectRoots = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Project mapping policy")
      .setDesc("MVP policy: map by transcript cwd or source path into a stable projectId. Manual remapping UI is planned after this MVP.")
      .addText((text) =>
        text.setValue("cwd prefix -> projectId").setDisabled(true)
      );

    new Setting(containerEl)
      .setName("Manual merge only")
      .setDesc("Keep project Markdown writes behind an explicit Confirm Apply action.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.manualMergeOnly).onChange(async (value) => {
          this.plugin.settings.manualMergeOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Privacy filters")
      .setDesc("One pattern per line. Matching injected/system context is filtered from transcript previews and evidence.")
      .addTextArea((text) =>
        text.setValue(this.plugin.settings.privacyPatterns.join("\n")).onChange(async (value) => {
          this.plugin.settings.privacyPatterns = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Trace quote length")
      .setDesc("Maximum excerpt length stored in Markdown evidence and Canvas evidence.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxQuoteLength)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxQuoteLength = Number.isFinite(parsed) ? Math.max(80, parsed) : DEFAULT_SETTINGS.maxQuoteLength;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Cache Diagnostics" });
    containerEl.createEl("p", {
      text: this.plugin.lastDiagnostics.length
        ? this.plugin.lastDiagnostics.slice(0, 5).map((diagnostic) => `${diagnostic.code}: ${diagnostic.recoveryActionLabel}`).join(" ")
        : "No scan diagnostics captured in this session."
    });
  }
}
