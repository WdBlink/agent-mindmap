import { homedir } from "os";
import { join } from "path";

export interface AgentMindmapSettings {
  memoryRoot: string;
  codexSessionRoots: string[];
  claudeProjectRoots: string[];
  claudeAppSessionRoots: string[];
  autoDiscoverSessionRoots: boolean;
  privacyPatterns: string[];
  maxQuoteLength: number;
  manualMergeOnly: boolean;
}

export const DEFAULT_PRIVACY_PATTERNS = [
  "<environment_context>",
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<plugins_instructions>",
  "AGENTS.md",
  "api_key",
  "apikey",
  "authorization:",
  "bearer ",
  "password",
  "secret",
  "token"
];

export const DEFAULT_SETTINGS: AgentMindmapSettings = {
  memoryRoot: "AI-Projects",
  codexSessionRoots: [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions")
  ],
  claudeProjectRoots: [join(homedir(), ".claude", "projects")],
  claudeAppSessionRoots: [
    join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")
  ],
  autoDiscoverSessionRoots: true,
  privacyPatterns: DEFAULT_PRIVACY_PATTERNS,
  maxQuoteLength: 280,
  manualMergeOnly: true
};

export function normalizeSettings(input?: Partial<AgentMindmapSettings>): AgentMindmapSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    codexSessionRoots: input?.codexSessionRoots?.length
      ? input.codexSessionRoots
      : DEFAULT_SETTINGS.codexSessionRoots,
    claudeProjectRoots: input?.claudeProjectRoots?.length
      ? input.claudeProjectRoots
      : DEFAULT_SETTINGS.claudeProjectRoots,
    claudeAppSessionRoots: input?.claudeAppSessionRoots?.length
      ? input.claudeAppSessionRoots
      : DEFAULT_SETTINGS.claudeAppSessionRoots,
    autoDiscoverSessionRoots: input?.autoDiscoverSessionRoots ?? DEFAULT_SETTINGS.autoDiscoverSessionRoots,
    privacyPatterns: input?.privacyPatterns?.length
      ? input.privacyPatterns
      : DEFAULT_SETTINGS.privacyPatterns,
    maxQuoteLength: Math.max(80, input?.maxQuoteLength ?? DEFAULT_SETTINGS.maxQuoteLength),
    manualMergeOnly: input?.manualMergeOnly ?? DEFAULT_SETTINGS.manualMergeOnly
  };
}
