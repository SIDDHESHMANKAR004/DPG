import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import type { ProjectScan } from "./scanner.js";
import { getGitChanges } from "./gitChanges.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-git-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

function projectMetadata(directory: string): ProjectScan {
  return {
    directory,
    name: "git-test",
    scannedAt: new Date().toISOString(),
    technologies: [],
    packageManager: null,
    scripts: {},
    gitRepository: true,
    findings: [],
    truncated: false,
  };
}

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", directory, ...args], {
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

describe("getGitChanges", () => {
  it("reports read-only repository status, bounded diffs, secret warnings, and commits", async () => {
    const directory = await createDirectory();
    await git(directory, "init", "-q");
    await git(directory, "config", "user.email", "test@example.invalid");
    await git(directory, "config", "user.name", "Test User");
    await writeFile(path.join(directory, "tracked.ts"), "export const value = 1;\n");
    await git(directory, "add", "tracked.ts");
    await git(directory, "commit", "-m", "initial project");

    await writeFile(path.join(directory, "tracked.ts"), "export const value = 2;\n");
    await writeFile(path.join(directory, "staged.ts"), "export const staged = true;\n");
    await git(directory, "add", "staged.ts");
    await writeFile(path.join(directory, ".env"), "SECRET_CONTENT_MUST_NOT_APPEAR\n");
    await git(directory, "add", ".env");
    await writeFile(path.join(directory, "new.ts"), "export const untracked = true;\n");

    const result = await getGitChanges(projectMetadata(directory));
    const serialized = JSON.stringify(result);

    assert.equal(result.status, "available");
    assert.ok(result.branch);
    assert.equal(result.staged.length, 2);
    assert.ok(result.staged.some((file) => file.path === "staged.ts"));
    assert.ok(result.staged.some((file) => file.path === ".env" && file.likelySecret));
    assert.deepEqual(result.unstaged.map((file) => file.path), ["tracked.ts"]);
    assert.deepEqual(result.untracked.map((file) => file.path), ["new.ts"]);
    assert.equal(result.recentCommits.length, 1);
    assert.match(result.recentCommits[0], /initial project/);
    assert.ok(!serialized.includes("SECRET_CONTENT_MUST_NOT_APPEAR"));
    assert.match(result.warnings.join(" "), /Likely secret file paths detected/);
    assert.match(result.stagedDiff.text, /staged\.ts/);
    assert.doesNotMatch(result.stagedDiff.text, /\.env/);
    assert.match(result.unstagedDiff.text, /tracked\.ts/);

    const statusBefore = await execFileAsync("git", ["-C", directory, "status", "--porcelain"]);
    const statusAfter = await execFileAsync("git", ["-C", directory, "status", "--porcelain"]);
    assert.equal(statusAfter.stdout, statusBefore.stdout);
  });

  it("handles a clean repository without changes", async () => {
    const directory = await createDirectory();
    await git(directory, "init", "-q");
    await git(directory, "config", "user.email", "test@example.invalid");
    await git(directory, "config", "user.name", "Test User");
    await writeFile(path.join(directory, "README.md"), "hello\n");
    await git(directory, "add", "README.md");
    await git(directory, "commit", "-m", "initial");

    const result = await getGitChanges(projectMetadata(directory));

    assert.equal(result.status, "available");
    assert.equal(result.totalFileCount, 0);
    assert.match(result.summary[0], /working tree is clean/i);
    assert.equal(result.stagedDiff.text, "");
    assert.equal(result.unstagedDiff.text, "");
  });

  it("handles a directory outside Git", async () => {
    const directory = await createDirectory();

    const result = await getGitChanges(projectMetadata(directory));

    assert.equal(result.status, "not-git");
    assert.match(result.message ?? "", /not inside a Git repository/);
  });
});
