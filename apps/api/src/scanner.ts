import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const secretFilePattern =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519))$|(?:\.(?:pem|key|p12|pfx))$/i;
const maxEntries = 10_000;
const maxDepth = 8;

export interface ProjectScan {
  directory: string;
  name: string;
  scannedAt: string;
  technologies: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  gitRepository: boolean;
  findings: string[];
  truncated: boolean;
}

export class ScanInputError extends Error {}

function isSecretFile(name: string): boolean {
  return secretFilePattern.test(name);
}

function packageManagerFromFiles(files: Set<string>, declared?: string): string | null {
  if (declared) return declared.split("@")[0];
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) return "npm";
  return null;
}

export async function scanProject(inputDirectory: string): Promise<ProjectScan> {
  if (!path.isAbsolute(inputDirectory) || inputDirectory.trim() !== inputDirectory) {
    throw new ScanInputError("Enter an absolute project directory path.");
  }

  let directory: string;
  try {
    directory = await realpath(inputDirectory);
    if (!(await stat(directory)).isDirectory()) {
      throw new ScanInputError("The selected path is not a directory.");
    }
  } catch (error) {
    if (error instanceof ScanInputError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new ScanInputError("The selected directory does not exist.");
    }
    throw error;
  }

  const files = new Set<string>();
  let entriesVisited = 0;
  let truncated = false;
  let gitRepository = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || entriesVisited >= maxEntries) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }
    for (const entry of entries) {
      if (entriesVisited >= maxEntries) {
        truncated = true;
        return;
      }
      entriesVisited += 1;
      if (depth === 0 && entry.name === ".git" && (entry.isDirectory() || entry.isFile())) {
        gitRepository = true;
      }
      if (entry.isSymbolicLink() || isSecretFile(entry.name)) continue;
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name.toLowerCase())) continue;
        if (depth >= maxDepth) {
          truncated = true;
          continue;
        }
        await walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.add(path.relative(directory, path.join(current, entry.name)));
      }
    }
  }

  await walk(directory, 0);

  const rootFiles = new Set(
    [...files].filter((file) => !file.includes(path.sep)).map((file) => file),
  );
  const findings: string[] = [];
  let manifest: {
    name?: unknown;
    scripts?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    peerDependencies?: unknown;
    packageManager?: unknown;
  } | undefined;
  if (rootFiles.has("package.json")) {
    const contents = await readFile(path.join(directory, "package.json"), "utf8");
    try {
      manifest = JSON.parse(contents) as typeof manifest;
      findings.push("Root package.json found.");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      findings.push("Root package.json is invalid JSON.");
    }
  } else {
    findings.push("No root package.json found.");
  }

  const dependencies = [
    manifest?.dependencies,
    manifest?.devDependencies,
    manifest?.peerDependencies,
  ].filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  const hasDependency = (name: string) =>
    dependencies.some((group) => Object.hasOwn(group, name));
  const technologies: string[] = [];
  if (rootFiles.has("package.json")) technologies.push("Node.js");
  if (
    hasDependency("vite") ||
    [...files].some((file) => /(^|[\\/])vite\.config\.[^\\/]+$/.test(file))
  ) {
    technologies.push("Vite");
  }
  if (hasDependency("react") || hasDependency("react-dom")) technologies.push("React");
  if (
    hasDependency("typescript") ||
    [...files].some((file) => /\.(?:ts|tsx|mts|cts)$/.test(file)) ||
    [...files].some((file) => /(^|[\\/])tsconfig(?:\.[^\\/]+)?\.json$/.test(file))
  ) {
    technologies.push("TypeScript");
  }

  const declaredManager =
    typeof manifest?.packageManager === "string" ? manifest.packageManager : undefined;
  const packageManager = packageManagerFromFiles(rootFiles, declaredManager);
  if (packageManager) technologies.push(packageManager);

  const scripts =
    typeof manifest?.scripts === "object" &&
    manifest.scripts !== null &&
    !Array.isArray(manifest.scripts)
      ? Object.fromEntries(
          Object.entries(manifest.scripts).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};

  const hasTypeScriptConfig = [...files].some((file) =>
    /(^|[\\/])tsconfig(?:\.[^\\/]+)?\.json$/.test(file),
  );
  const hasViteConfig = [...files].some((file) =>
    /(^|[\\/])vite\.config\.[^\\/]+$/.test(file),
  );
  if (hasTypeScriptConfig) findings.push("TypeScript configuration found.");
  if (hasViteConfig) findings.push("Vite configuration found.");
  if (!packageManager) findings.push("No recognized package-manager lockfile found.");
  if (truncated) findings.push("Scan limits reached; results may be incomplete.");

  return {
    directory,
    name:
      typeof manifest?.name === "string" && manifest.name.trim()
        ? manifest.name
        : path.basename(directory),
    scannedAt: new Date().toISOString(),
    technologies,
    packageManager,
    scripts,
    gitRepository,
    findings,
    truncated,
  };
}
