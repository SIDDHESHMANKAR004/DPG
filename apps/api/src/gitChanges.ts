import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectScan } from "./scanner.js";

const processTimeoutMs = 15_000;
const maxProcessOutputBytes = 128 * 1024;
const maxFiles = 200;
const maxDiffPreviewChars = 12_000;
const secretPathPattern =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519))$|(?:\.(?:pem|key|p12|pfx))$/i;

export interface GitFileChange {
  path: string;
  previousPath?: string;
  status: string;
  likelySecret: boolean;
}

export interface GitDiffPreview {
  text: string;
  truncated: boolean;
}

export interface GitChangesResult {
  status: "available" | "not-git" | "unavailable" | "failure";
  project: string;
  branch: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  totalFileCount: number;
  fileListTruncated: boolean;
  recentCommits: string[];
  stagedDiff: GitDiffPreview;
  unstagedDiff: GitDiffPreview;
  summary: string[];
  warnings: string[];
  message?: string;
  completedAt: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function appendBounded(current: string, chunk: Buffer): { text: string; truncated: boolean } {
  const remaining = Math.max(0, maxProcessOutputBytes - Buffer.byteLength(current));
  const text = chunk.toString("utf8");
  const accepted = Buffer.from(text).subarray(0, remaining).toString("utf8");
  return { text: current + accepted, truncated: accepted.length < text.length };
}

function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["--no-pager", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
      },
    );
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, processTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const bounded = appendBounded(stdout, chunk);
      stdout = bounded.text;
      outputTruncated ||= bounded.truncated;
      if (bounded.truncated) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bounded = appendBounded(stderr, chunk);
      stderr = bounded.text;
      outputTruncated ||= bounded.truncated;
      if (bounded.truncated) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: code, stdout, stderr, outputTruncated, timedOut });
    });
  });
}

function parseStatus(output: string): {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
} {
  const tokens = output.split("\0");
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    const previousPath =
      status.includes("R") || status.includes("C") ? tokens[index + 1] : undefined;
    if (previousPath !== undefined) index += 1;
    const change: GitFileChange = {
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      status,
      likelySecret:
        secretPathPattern.test(filePath.replace(/\\/g, "/")) ||
        Boolean(previousPath && secretPathPattern.test(previousPath.replace(/\\/g, "/"))),
    };
    if (status === "??") {
      untracked.push(change);
    } else {
      if (status[0] !== " ") staged.push(change);
      if (status[1] !== " ") unstaged.push(change);
    }
  }
  return { staged, unstaged, untracked };
}

function limited<T>(items: T[]): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, maxFiles), truncated: items.length > maxFiles };
}

function summarize(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  untracked: GitFileChange[],
): string[] {
  const total = staged.length + unstaged.length + untracked.length;
  if (total === 0) return ["Working tree is clean; there are no staged, unstaged, or untracked changes."];

  const summaries = [
    `${staged.length} staged ${staged.length === 1 ? "file" : "files"}`,
    `${unstaged.length} unstaged ${unstaged.length === 1 ? "file" : "files"}`,
    `${untracked.length} untracked ${untracked.length === 1 ? "file" : "files"}`,
  ];
  const extensions = new Map<string, number>();
  for (const change of [...staged, ...unstaged, ...untracked]) {
    const extension = path.posix.extname(change.path).toLowerCase() || "[no extension]";
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  const commonExtensions = [...extensions.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([extension, count]) => `${count} ${extension}`);
  if (commonExtensions.length) summaries.push(`Most changed file types: ${commonExtensions.join(", ")}.`);
  return summaries;
}

function createDiffPreview(output: string, truncated: boolean): GitDiffPreview {
  if (output.length <= maxDiffPreviewChars) return { text: output, truncated };
  return {
    text: `${output.slice(0, maxDiffPreviewChars)}\n\n[Diff preview truncated.]`,
    truncated: true,
  };
}

function emptyDiff(): GitDiffPreview {
  return { text: "", truncated: false };
}

function baseResult(
  project: string,
  status: GitChangesResult["status"],
  message: string,
): GitChangesResult {
  return {
    status,
    project,
    branch: null,
    staged: [],
    unstaged: [],
    untracked: [],
    totalFileCount: 0,
    fileListTruncated: false,
    recentCommits: [],
    stagedDiff: emptyDiff(),
    unstagedDiff: emptyDiff(),
    summary: [message],
    warnings: [],
    message,
    completedAt: new Date().toISOString(),
  };
}

async function readDiff(
  directory: string,
  files: GitFileChange[],
  staged: boolean,
): Promise<GitDiffPreview> {
  const safeFiles = files.filter((file) => !file.likelySecret).map((file) => file.path);
  if (safeFiles.length === 0) return emptyDiff();
  const args = [
    "diff",
    ...(staged ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=1",
    "--",
    ...safeFiles.map((file) => `:(literal)${file}`),
  ];
  const result = await runGit(args, directory);
  return createDiffPreview(
    result.stdout,
    result.outputTruncated || result.timedOut || result.exitCode !== 0,
  );
}

export async function getGitChanges(project: ProjectScan): Promise<GitChangesResult> {
  let directory: string;
  try {
    directory = await realpath(project.directory);
    if (!samePath(directory, project.directory) || !(await stat(directory)).isDirectory()) {
      return baseResult(project.directory, "failure", "The saved project directory is no longer valid.");
    }
  } catch {
    return baseResult(project.directory, "failure", "The saved project directory is no longer available.");
  }

  let repositoryRoot: string;
  try {
    const rootResult = await runGit(["rev-parse", "--show-toplevel"], directory);
    if (rootResult.exitCode !== 0 || rootResult.timedOut || rootResult.outputTruncated) {
      return baseResult(project.directory, "not-git", "This project is not inside a Git repository.");
    }
    repositoryRoot = await realpath(rootResult.stdout.trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return baseResult(project.directory, "unavailable", "Git is not installed or unavailable on this system.");
    }
    throw error;
  }
  if (!samePath(repositoryRoot, directory)) {
    return baseResult(project.directory, "not-git", "The selected project directory is not a Git repository root.");
  }

  const statusResult = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    directory,
  );
  if (statusResult.exitCode !== 0 || statusResult.timedOut || statusResult.outputTruncated) {
    return baseResult(project.directory, "failure", "Git status could not be read completely.");
  }
  const changes = parseStatus(statusResult.stdout);
  const totalFileCount = new Set(
    [...changes.staged, ...changes.unstaged, ...changes.untracked].map((change) => change.path),
  ).size;
  const stagedLimited = limited(changes.staged);
  const unstagedLimited = limited(changes.unstaged);
  const untrackedLimited = limited(changes.untracked);
  const secretFiles = [...changes.staged, ...changes.unstaged, ...changes.untracked]
    .filter((file) => file.likelySecret)
    .map((file) => file.path);
  const stagedDiff = await readDiff(directory, stagedLimited.items, true);
  const unstagedDiff = await readDiff(directory, unstagedLimited.items, false);
  const branchResult = await runGit(["branch", "--show-current"], directory);
  let branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
  if (!branch) {
    const headResult = await runGit(["rev-parse", "--short", "HEAD"], directory);
    branch =
      headResult.exitCode === 0 && headResult.stdout.trim()
        ? `Detached HEAD (${headResult.stdout.trim()})`
        : "Unborn branch";
  }
  const logResult = await runGit(["log", "-5", "--format=%h%x09%s%x09%cr"], directory);
  const recentCommits =
    logResult.exitCode === 0
      ? logResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 5)
      : [];
  const fileListTruncated =
    stagedLimited.truncated || unstagedLimited.truncated || untrackedLimited.truncated;
  const warnings = secretFiles.length
    ? [`Likely secret file paths detected (${secretFiles.length}); their diff contents are excluded.`]
    : [];
  if (fileListTruncated) warnings.push(`File list capped at ${maxFiles} entries per change category.`);
  if (stagedDiff.truncated || unstagedDiff.truncated) warnings.push("One or more diff previews were truncated.");
  if (statusResult.stderr) warnings.push("Git reported a status warning.");

  return {
    status: "available",
    project: project.directory,
    branch,
    staged: stagedLimited.items,
    unstaged: unstagedLimited.items,
    untracked: untrackedLimited.items,
    totalFileCount,
    fileListTruncated,
    recentCommits,
    stagedDiff,
    unstagedDiff,
    summary: summarize(changes.staged, changes.unstaged, changes.untracked),
    warnings,
    completedAt: new Date().toISOString(),
  };
}
