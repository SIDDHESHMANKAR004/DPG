import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { scanProject, type ProjectScan } from "../../api/src/scanner.js";

export interface RegisteredProject {
  id: string;
  scan: ProjectScan;
}

export class ProjectRegistry {
  private readonly projects = new Map<string, RegisteredProject>();

  list(): RegisteredProject[] {
    return [...this.projects.values()];
  }

  get(id: string): RegisteredProject | undefined {
    return this.projects.get(id);
  }

  async register(inputDirectory: string): Promise<RegisteredProject> {
    const directory = await validateProjectPath(inputDirectory);
    const scan = await scanProject(directory);
    const existing = [...this.projects.values()].find(
      (project) => samePath(project.scan.directory, scan.directory),
    );
    if (existing) {
      const updated = { ...existing, scan };
      this.projects.set(existing.id, updated);
      return updated;
    }

    const project = { id: randomUUID(), scan };
    this.projects.set(project.id, project);
    return project;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function validateProjectPath(inputDirectory: string): Promise<string> {
  if (!inputDirectory || inputDirectory.trim() !== inputDirectory || !path.isAbsolute(inputDirectory)) {
    throw new Error("Project directory must be an absolute local path.");
  }
  if (process.platform === "win32" && /^(?:\\\\|\/\/)/.test(inputDirectory)) {
    throw new Error("Network and UNC paths are not supported.");
  }

  const directory = await realpath(inputDirectory);
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("Selected project path is not a directory.");
  }
  return directory;
}
