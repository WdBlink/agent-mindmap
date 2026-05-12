import { basename } from "path";
import { slugifyId, stableId } from "./ids";
import type { Project, Session } from "../types";

export interface ProjectMappingOptions {
  memoryRoot: string;
  existingProjects?: Project[];
}

export function mapSessionToProject(session: Session, options: ProjectMappingOptions): Project {
  const existing = findExistingProject(session, options.existingProjects ?? []);
  if (existing) {
    return {
      ...existing,
      sessionIds: Array.from(new Set([...existing.sessionIds, session.id])),
      updatedAt: Date.now()
    };
  }

  const name = inferProjectName(session);
  const id = stableId("project", session.projectPath ?? name);
  const folderName = slugifyId(name);
  const vaultPath = `${trimSlashes(options.memoryRoot)}/Projects/${folderName}`;

  return {
    id,
    name,
    rootPath: session.projectPath,
    vaultPath,
    aliases: [name, folderName].filter((value, index, values) => values.indexOf(value) === index),
    sessionIds: [session.id],
    stateFile: `${vaultPath}/project-state.md`,
    canvasFile: `${vaultPath}/map.canvas`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function inferProjectName(session: Session): string {
  if (session.projectPath) {
    return basename(session.projectPath);
  }
  if (session.title) {
    return session.title;
  }
  return session.id;
}

function findExistingProject(session: Session, projects: Project[]): Project | null {
  return (
    projects.find((project) => project.sessionIds.includes(session.id)) ??
    projects.find((project) => project.rootPath && project.rootPath === session.projectPath) ??
    projects.find((project) => session.title && project.aliases.includes(session.title)) ??
    null
  );
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
