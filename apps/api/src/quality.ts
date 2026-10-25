import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectScan } from "./scanner.js";

const timeoutMs = 60_000;
const maxOutputBytes = 256 * 1024;
const ignoredPaths = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.cache/**",
  "**/.pytest_cache/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.vite/**",
  "**/.turbo/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/vendor/**",
  "**/out/**",
  "**/.env",
  "**/.env.*",
  "**/.npmrc",
  "**/.pypirc",
  "**/credentials*",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
];

export type DiagnosticSeverity = "error" | "warning";
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  occurrences: number;
}

export interface CheckResult {
  tool: "ESLint" | "TypeScript";
  status: "success" | "failure" | "unavailable" | "skipped" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostics: Diagnostic[];
  note?: string;
}

export interface QualityResult {
  project: string;
  checks: CheckResult[];
  status: "success" | "failure" | "unavailable" | "cancelled";
  completedAt: string;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

function isWithinDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function localToolPath(directory: string, relativePath: string): Promise<string | undefined> {
  const candidate = path.join(directory, "node_modules", ...relativePath.split("/"));
  try {
    const resolved = await realpath(candidate);
    if (!isWithinDirectory(directory, resolved) || !(await stat(resolved)).isFile()) return undefined;
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

function appendBounded(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current));
  const text = chunk.toString("utf8");
  const accepted = Buffer.from(text).subarray(0, remaining).toString("utf8");
  return { value: current + accepted, truncated: accepted.length < text.length };
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        timedOut: false,
        cancelled: true,
      });
      return;
    }

    const child = spawn(process.execPath, [executable, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = () => {
      child.kill();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const bounded = appendBounded(stdout, chunk, maxOutputBytes);
      stdout = bounded.value;
      outputTruncated ||= bounded.truncated;
      if (bounded.truncated) terminate();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bounded = appendBounded(stderr, chunk, maxOutputBytes);
      stderr = bounded.value;
      outputTruncated ||= bounded.truncated;
      if (bounded.truncated) terminate();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) =>
      finish({
        exitCode: code,
        stdout,
        stderr,
        outputTruncated,
        timedOut,
        cancelled,
      }),
    );
  });
}

function groupDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const grouped = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([
      diagnostic.severity,
      diagnostic.message,
      diagnostic.file,
      diagnostic.line,
      diagnostic.column,
    ]);
    const existing = grouped.get(key);
    if (existing) existing.occurrences += diagnostic.occurrences;
    else grouped.set(key, { ...diagnostic });
  }
  return [...grouped.values()];
}

export function parseEslintDiagnostics(output: string, directory: string): Diagnostic[] {
  let results: unknown;
  try {
    results = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(results)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    if (typeof result !== "object" || result === null) continue;
    const item = result as Record<string, unknown>;
    const file =
      typeof item.filePath === "string"
        ? path.relative(directory, item.filePath).split(path.sep).join("/")
        : undefined;
    const messages = Array.isArray(item.messages) ? item.messages : [];
    for (const entry of messages) {
      if (typeof entry !== "object" || entry === null) continue;
      const message = entry as Record<string, unknown>;
      if (typeof message.message !== "string") continue;
      diagnostics.push({
        severity: message.severity === 2 ? "error" : "warning",
        message:
          typeof message.ruleId === "string"
            ? `${message.message} (${message.ruleId})`
            : message.message,
        ...(file ? { file } : {}),
        ...(typeof message.line === "number" ? { line: message.line } : {}),
        ...(typeof message.column === "number" ? { column: message.column } : {}),
        occurrences: 1,
      });
    }
  }
  return groupDiagnostics(diagnostics);
}

export function parseTypeScriptDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern =
    /^(?:(.+?)\((\d+),(\d+)\): )?(error|warning) TS\d+: (.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    diagnostics.push({
      severity: match[4] === "error" ? "error" : "warning",
      message: match[5],
      ...(match[1] ? { file: match[1].replace(/\\/g, "/") } : {}),
      ...(match[2] ? { line: Number(match[2]) } : {}),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      occurrences: 1,
    });
  }
  return groupDiagnostics(diagnostics);
}

function emptyResult(
  tool: CheckResult["tool"],
  status: CheckResult["status"],
  note: string,
): CheckResult {
  return {
    tool,
    status,
    exitCode: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    diagnostics: [],
    note,
  };
}

async function runCheck(
  tool: CheckResult["tool"],
  directory: string,
  executable: string,
  args: string[],
  signal?: AbortSignal,
  configurationNote?: string,
): Promise<CheckResult> {
  try {
    const result = await runProcess(executable, args, directory, signal);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const diagnostics =
      tool === "ESLint"
        ? parseEslintDiagnostics(result.stdout, directory)
        : parseTypeScriptDiagnostics(combinedOutput);
    if (result.cancelled) {
      return {
        tool,
        status: "cancelled",
        exitCode: null,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.outputTruncated,
        diagnostics,
        note: "Check cancelled.",
      };
    }
    const notes = [
      configurationNote,
      result.timedOut ? `Check timed out after ${timeoutMs / 1000} seconds.` : undefined,
      result.outputTruncated ? `Output limit of ${Math.round(maxOutputBytes / 1024)} KB reached.` : undefined,
    ].filter((note): note is string => Boolean(note));
    return {
      tool,
      status: result.exitCode === 0 &&
        !result.timedOut &&
        !result.outputTruncated &&
        !diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "success"
        : "failure",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
      diagnostics,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyResult(tool, "unavailable", `Local ${tool} executable could not be started.`);
    }
    throw error;
  }
}

function scriptExists(project: ProjectScan, names: string[]): boolean {
  return names.some((name) => Object.hasOwn(project.scripts, name));
}

function overallStatus(checks: CheckResult[]): QualityResult["status"] {
  if (checks.some((check) => check.status === "cancelled")) return "cancelled";
  if (checks.some((check) => check.status === "failure")) return "failure";
  if (checks.every((check) => check.status === "unavailable" || check.status === "skipped")) {
    return "unavailable";
  }
  return "success";
}

export async function runQualityChecks(
  project: ProjectScan,
  signal?: AbortSignal,
): Promise<QualityResult> {
  const directory = await realpath(project.directory);
  if (!samePath(directory, project.directory) || !(await stat(directory)).isDirectory()) {
    throw new Error("The saved project directory is no longer valid.");
  }
  const checks: CheckResult[] = [];
  const packageJsonPath = path.join(directory, "package.json");
  let manifest: { scripts?: unknown; eslintConfig?: unknown } | undefined;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as typeof manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)) throw error;
  }
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
  const projectMetadata = { ...project, scripts };

  const eslintConfigNames = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ];
  let eslintConfigured = Boolean(manifest?.eslintConfig);
  for (const name of eslintConfigNames) {
    try {
      if ((await stat(path.join(directory, name))).isFile()) eslintConfigured = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (eslintConfigured) {
    const eslint = await localToolPath(directory, "eslint/bin/eslint.js");
    const lintScriptNote = scriptExists(projectMetadata, ["lint", "lint:check"])
      ? undefined
      : "No lint script is defined; the local tool will use fixed read-only arguments.";
    if (!eslint) {
      checks.push(emptyResult("ESLint", "unavailable", "ESLint is configured but not installed locally."));
    } else if (signal?.aborted) {
      checks.push(emptyResult("ESLint", "cancelled", "Check cancelled."));
    } else {
      checks.push(await runCheck("ESLint", directory, eslint, [
        "--format", "json",
        "--no-color",
        ...ignoredPaths.flatMap((pattern) => ["--ignore-pattern", pattern]),
        ".",
      ], signal, lintScriptNote));
    }
  } else {
    checks.push(emptyResult(
      "ESLint",
      "skipped",
      scriptExists(projectMetadata, ["lint", "lint:check"])
        ? "No ESLint configuration found; configured scripts are never run."
        : "No ESLint configuration or lint script found.",
    ));
  }

  let hasTsConfig = false;
  try {
    hasTsConfig = (await stat(path.join(directory, "tsconfig.json"))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (hasTsConfig) {
    const typescript = await localToolPath(directory, "typescript/bin/tsc");
    const typeScriptNote = scriptExists(projectMetadata, ["typecheck", "type-check", "check:types"])
      ? undefined
      : "No type-check script is defined; the local tool will use fixed read-only arguments.";
    if (!typescript) {
      checks.push(emptyResult("TypeScript", "unavailable", "TypeScript is configured but not installed locally."));
    } else if (signal?.aborted) {
      checks.push(emptyResult("TypeScript", "cancelled", "Check cancelled."));
    } else {
      checks.push(await runCheck("TypeScript", directory, typescript, [
        "--noEmit",
        "--pretty",
        "false",
        "--project",
        "tsconfig.json",
      ], signal, typeScriptNote));
    }
  } else {
    checks.push(emptyResult("TypeScript", "skipped", "No root tsconfig.json found."));
  }

  return {
    project: project.directory,
    checks,
    status: overallStatus(checks),
    completedAt: new Date().toISOString(),
  };
}
