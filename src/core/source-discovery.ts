import { homedir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, type AgentMindmapSettings } from "../settings";

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths
    .map((path) => expandHome(path.trim()))
    .filter(Boolean)
    .filter((path) => {
      if (seen.has(path)) {
        return false;
      }
      seen.add(path);
      return true;
    });
}

export function effectiveCodexSessionRoots(settings: AgentMindmapSettings): string[] {
  const defaults = settings.autoDiscoverSessionRoots ? DEFAULT_SETTINGS.codexSessionRoots : [];
  return uniquePaths([...settings.codexSessionRoots, ...defaults]);
}

export function effectiveClaudeProjectRoots(settings: AgentMindmapSettings): string[] {
  const defaults = settings.autoDiscoverSessionRoots ? DEFAULT_SETTINGS.claudeProjectRoots : [];
  return uniquePaths([...settings.claudeProjectRoots, ...defaults]);
}

export function defaultClaudeAppSessionRoots(): string[] {
  return [join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")];
}

export function effectiveClaudeAppSessionRoots(settings: AgentMindmapSettings): string[] {
  const defaults = settings.autoDiscoverSessionRoots ? defaultClaudeAppSessionRoots() : [];
  return uniquePaths([...(settings.claudeAppSessionRoots ?? []), ...defaults]);
}
