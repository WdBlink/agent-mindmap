import type { PluginManifest } from "obsidian";
import type { StoragePort } from "./storage";

export const AGENT_MINDMAP_REPOSITORY = {
  owner: "WdBlink",
  repo: "agent-mindmap"
} as const;

const REQUIRED_RELEASE_ASSETS = ["main.js", "manifest.json", "styles.css"] as const;

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubReleaseResponse {
  tag_name: string;
  name?: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GitHubReleaseAsset[];
}

export interface ReleaseAssetMap {
  "main.js": string;
  "manifest.json": string;
  "styles.css": string;
}

export interface PluginUpdateResult {
  status: "already-current" | "updated";
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  writtenFiles: string[];
  backupDir: string | null;
  message: string;
}

export interface PluginUpdaterOptions {
  storage: StoragePort;
  pluginDir: string;
  currentManifest: PluginManifest;
  now?: () => Date;
  fetchLatestRelease?: () => Promise<GitHubReleaseResponse>;
  fetchAssetText?: (url: string) => Promise<string>;
}

export type RequestUrlLike = (options: { url: string; headers: Record<string, string> }) => Promise<{ json?: unknown; text: string }>;

export class PluginUpdater {
  private readonly now: () => Date;
  private readonly fetchLatestRelease: () => Promise<GitHubReleaseResponse>;
  private readonly fetchAssetText: (url: string) => Promise<string>;

  constructor(private readonly options: PluginUpdaterOptions) {
    this.now = options.now ?? (() => new Date());
    this.fetchLatestRelease = options.fetchLatestRelease ?? fetchLatestGitHubRelease;
    this.fetchAssetText = options.fetchAssetText ?? fetchTextAsset;
  }

  async updateFromLatestRelease(): Promise<PluginUpdateResult> {
    const pluginDir = normalizePluginDir(this.options.pluginDir);
    const release = await this.fetchLatestRelease();
    if (release.draft) {
      throw new Error("Latest GitHub release is still a draft.");
    }
    if (release.prerelease) {
      throw new Error("Latest GitHub release is a prerelease; stable updates only.");
    }

    const latestVersion = normalizeVersion(release.tag_name);
    const currentVersion = normalizeVersion(this.options.currentManifest.version);
    const comparison = compareSemver(latestVersion, currentVersion);
    if (comparison <= 0) {
      return {
        status: "already-current",
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url,
        writtenFiles: [],
        backupDir: null,
        message: `Agent Mindmap is already current (${currentVersion}).`
      };
    }

    const assets = requireReleaseAssets(release);
    const downloaded = await this.downloadAssets(assets);
    const manifest = parseManifest(downloaded["manifest.json"]);
    validateManifest(manifest, this.options.currentManifest.id, latestVersion);

    const backupDir = `${pluginDir}/.backups/${backupStamp(this.now())}`;
    const writtenFiles: string[] = [];
    for (const assetName of REQUIRED_RELEASE_ASSETS) {
      const targetPath = `${pluginDir}/${assetName}`;
      if (await this.options.storage.exists(targetPath)) {
        await this.options.storage.write(`${backupDir}/${assetName}`, await this.options.storage.read(targetPath));
      }
      await this.options.storage.write(targetPath, downloaded[assetName]);
      writtenFiles.push(targetPath);
    }

    return {
      status: "updated",
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      writtenFiles,
      backupDir,
      message: `Updated Agent Mindmap from ${currentVersion} to ${latestVersion}. Restart Obsidian or reload plugins to use the new version.`
    };
  }

  private async downloadAssets(assets: Record<keyof ReleaseAssetMap, GitHubReleaseAsset>): Promise<ReleaseAssetMap> {
    return {
      "main.js": await this.fetchAssetText(assets["main.js"].browser_download_url),
      "manifest.json": await this.fetchAssetText(assets["manifest.json"].browser_download_url),
      "styles.css": await this.fetchAssetText(assets["styles.css"].browser_download_url)
    };
  }
}

export async function fetchLatestGitHubRelease(): Promise<GitHubReleaseResponse> {
  const url = `https://api.github.com/repos/${AGENT_MINDMAP_REPOSITORY.owner}/${AGENT_MINDMAP_REPOSITORY.repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "obsidian-agent-mindmap"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub latest release request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubReleaseResponse;
}

export async function fetchTextAsset(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "obsidian-agent-mindmap"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub release asset request failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export function obsidianReleaseFetcher(requestUrl: RequestUrlLike): () => Promise<GitHubReleaseResponse> {
  return async () => {
    const url = `https://api.github.com/repos/${AGENT_MINDMAP_REPOSITORY.owner}/${AGENT_MINDMAP_REPOSITORY.repo}/releases/latest`;
    const response = await requestUrl({
      url,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "obsidian-agent-mindmap"
      }
    });
    return response.json as GitHubReleaseResponse;
  };
}

export function obsidianTextAssetFetcher(requestUrl: RequestUrlLike): (url: string) => Promise<string> {
  return async (url: string) => {
    const response = await requestUrl({
      url,
      headers: {
        "User-Agent": "obsidian-agent-mindmap"
      }
    });
    return response.text;
  };
}

export function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function parseSemver(value: string): [number, number, number] {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function normalizePluginDir(dir: string | undefined): string {
  const normalized = dir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.includes("..") || normalized.startsWith("/")) {
    throw new Error("Cannot determine a safe vault-relative plugin directory.");
  }
  return normalized;
}

function requireReleaseAssets(release: GitHubReleaseResponse): Record<keyof ReleaseAssetMap, GitHubReleaseAsset> {
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const missing = REQUIRED_RELEASE_ASSETS.filter((name) => !assetsByName.has(name));
  if (missing.length) {
    throw new Error(`Latest release is missing required asset(s): ${missing.join(", ")}.`);
  }
  return {
    "main.js": assetsByName.get("main.js")!,
    "manifest.json": assetsByName.get("manifest.json")!,
    "styles.css": assetsByName.get("styles.css")!
  };
}

function parseManifest(content: string): PluginManifest {
  try {
    return JSON.parse(content) as PluginManifest;
  } catch (error) {
    throw new Error(`Downloaded manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifest(manifest: PluginManifest, expectedId: string, expectedVersion: string): void {
  if (manifest.id !== expectedId) {
    throw new Error(`Downloaded manifest id "${manifest.id}" does not match "${expectedId}".`);
  }
  if (normalizeVersion(manifest.version) !== expectedVersion) {
    throw new Error(`Downloaded manifest version "${manifest.version}" does not match release "${expectedVersion}".`);
  }
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
