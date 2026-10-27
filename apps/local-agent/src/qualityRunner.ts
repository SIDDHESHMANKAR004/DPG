import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  runQualityChecks,
  type QualityResult,
} from "../../api/src/quality.js";
import type { ProjectScan } from "../../api/src/scanner.js";

const buildTimeoutMs = 120_000;
const maxBuildOutputBytes = 128 * 1024;

export interface BuildResult {
  status: "success" | "failure" | "unavailable" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  note?: string;
}

export interface LocalQualityResult {
  checks: QualityResult;
  build: BuildResult | null;
}

function boundedAppend(current: string, chunk: Buffer): { value: string; truncated: boolean } {
  const remaining = Math.max(0, maxBuildOutputBytes - Buffer.byteLength(current));
  const text = chunk.toString("utf8");
  const accepted = Buffer.from(text).subarray(0, remaining).toString("utf8");
  return { value: current + accepted, truncated: accepted.length < text.length };
}

async function runApprovedBuild(
  project: ProjectScan,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const directory = await realpath(project.directory);
  if (!samePath(directory, project.directory) || !(await stat(directory)).isDirectory()) {
    throw new Error("The approved project directory is no longer valid.");
  }

  const packageJson = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  ) as { scripts?: Record<string, unknown> };
  if (typeof packageJson.scripts?.build !== "string") {
    return {
      status: "unavailable",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      note: "No build script is configured in package.json.",
    };
  }

  const npmCli = process.env.npm_execpath;
  if (!npmCli || !path.isAbsolute(npmCli)) {
    return {
      status: "unavailable",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      note: "Start the Local Agent through npm to make its npm CLI available.",
    };
  }
  if (signal?.aborted) {
    return {
      status: "cancelled",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      note: "Build cancelled.",
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, "--ignore-scripts", "run", "build"], {
      cwd: directory,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, buildTimeoutMs);
    const onAbort = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const result = boundedAppend(stdout, chunk);
      stdout = result.value;
      outputTruncated ||= result.truncated;
      if (result.truncated) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = boundedAppend(stderr, chunk);
      stderr = result.value;
      outputTruncated ||= result.truncated;
      if (result.truncated) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const status = cancelled
        ? "cancelled"
        : exitCode === 0 && !timedOut && !outputTruncated
          ? "success"
          : "failure";
      resolve({
        status,
        exitCode: cancelled || timedOut ? null : exitCode,
        stdout: "",
        stderr: "",
        outputTruncated,
        ...(timedOut
          ? { note: `Build timed out after ${buildTimeoutMs / 1000} seconds. Output is withheld.` }
          : outputTruncated
            ? { note: `Build output exceeded ${maxBuildOutputBytes / 1024} KB and is withheld.` }
            : cancelled
              ? { note: "Build cancelled." }
              : { note: "Build output is withheld because project scripts can print sensitive data." }),
      });
    });
  });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function runLocalQuality(
  project: ProjectScan,
  options: { includeBuild?: boolean; confirmBuild?: boolean; signal?: AbortSignal } = {},
): Promise<LocalQualityResult> {
  const checks = await runQualityChecks(project, options.signal);
  if (!options.includeBuild) return { checks, build: null };
  if (options.confirmBuild !== true) {
    return {
      checks,
      build: {
        status: "unavailable",
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        note: "Build not run; explicit user confirmation is required because the project build script can change files.",
      },
    };
  }
  return { checks, build: await runApprovedBuild(project, options.signal) };
}
