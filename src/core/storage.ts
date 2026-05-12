import type { DataAdapter } from "obsidian";
import type { SessionCacheEntry, SessionCacheFile } from "../types";

export interface StoragePort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export class ObsidianVaultStorage implements StoragePort {
  constructor(private readonly adapter: DataAdapter) {}

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    await ensureParentDir(this, path);
    await this.adapter.write(path, content);
  }

  async mkdir(path: string): Promise<void> {
    if (!(await this.adapter.exists(path))) {
      await this.adapter.mkdir(path);
    }
  }
}

export class SessionCache {
  constructor(
    private readonly storage: StoragePort,
    private readonly cachePath: string
  ) {}

  async load(): Promise<SessionCacheFile> {
    if (!(await this.storage.exists(this.cachePath))) {
      return { version: 1, entries: {} };
    }

    try {
      const parsed = JSON.parse(await this.storage.read(this.cachePath)) as SessionCacheFile;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        return parsed;
      }
    } catch {
      return { version: 1, entries: {} };
    }

    return { version: 1, entries: {} };
  }

  async save(cache: SessionCacheFile): Promise<void> {
    await this.storage.write(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  }

  async get(path: string): Promise<SessionCacheEntry | null> {
    const cache = await this.load();
    return cache.entries[path] ?? null;
  }

  async put(entry: SessionCacheEntry): Promise<void> {
    const cache = await this.load();
    cache.entries[entry.path] = entry;
    await this.save(cache);
  }
}

export async function ensureProjectDirs(storage: StoragePort, projectPath: string): Promise<void> {
  await storage.mkdir(projectPath);
  await storage.mkdir(`${projectPath}/sessions`);
}

export async function ensureParentDir(storage: StoragePort, filePath: string): Promise<void> {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return;
  }

  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    await storage.mkdir(current);
  }
}
