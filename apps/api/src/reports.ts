import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitChangesResult } from "./gitChanges.js";
import type { QualityResult } from "./quality.js";
import type { ProjectScan } from "./scanner.js";

const maxActivityEvents = 10_000;
let activityWriteQueue: Promise<void> = Promise.resolve();

interface ActivityBase {
  date: string;
  capturedAt: string;
  project: { name: string; directory: string };
}

export interface ScanActivity extends ActivityBase {
  type: "scan";
  technologies: string[];
  findings: string[];
}

export interface QualityActivity extends ActivityBase {
  type: "quality";
  status: QualityResult["status"];
  checks: QualityResult["checks"];
}

export interface GitActivity extends ActivityBase {
  type: "git";
  result: Omit<GitChangesResult, "stagedDiff" | "unstagedDiff">;
}

export type ReportActivity = ScanActivity | QualityActivity | GitActivity;

export interface DailyReport {
  date: string;
  generatedAt: string;
  markdown: string;
  activityCounts: { scans: number; qualityRuns: number; gitSnapshots: number };
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();
}

function code(value: string): string {
  return `\`${cleanInline(value).replace(/`/g, "'")}\``;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Report date must be a valid YYYY-MM-DD date.");
  }
}

function uniqueDiagnostics(events: QualityActivity[]) {
  const diagnostics = new Map<
    string,
    { project: string; tool: string; severity: string; message: string; file?: string; line?: number; occurrences: number }
  >();
  for (const event of events) {
    for (const check of event.checks) {
      for (const diagnostic of check.diagnostics) {
        const key = JSON.stringify([
          event.project.directory,
          check.tool,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.file,
          diagnostic.line,
          diagnostic.column,
        ]);
        const current = diagnostics.get(key);
        if (current) current.occurrences += diagnostic.occurrences;
        else {
          diagnostics.set(key, {
            project: event.project.name,
            tool: check.tool,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.file ? { file: diagnostic.file } : {}),
            ...(diagnostic.line ? { line: diagnostic.line } : {}),
            occurrences: diagnostic.occurrences,
          });
        }
      }
    }
  }
  return [...diagnostics.values()];
}

export function buildDailyReport(date: string, allEvents: ReportActivity[]): DailyReport {
  validateDate(date);
  const events = allEvents
    .filter((event) => event.date === date)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const scans = events.filter((event): event is ScanActivity => event.type === "scan");
  const qualityRuns = events.filter((event): event is QualityActivity => event.type === "quality");
  const gitSnapshots = events.filter((event): event is GitActivity => event.type === "git");

  const lines = [
    `# Daily Developer Work Report`,
    ``,
    `**Period:** ${date} (local date)  `,
    `**Generated:** ${new Date().toLocaleString()}`,
    ``,
    `## Observed activity`,
    ``,
    `- Project scans: ${scans.length}`,
    `- Quality check runs: ${qualityRuns.length}`,
    `- Git snapshots: ${gitSnapshots.length}`,
    ``,
    `### Project scans`,
  ];
  if (scans.length === 0) lines.push(`- No project scans recorded for this date.`);
  else {
    for (const event of scans) {
      const technologies = event.technologies.length ? event.technologies.join(", ") : "none detected";
      lines.push(`- ${formatTime(event.capturedAt)} — ${code(event.project.name)} (${code(event.project.directory)}); technologies: ${cleanInline(technologies)}.`);
      if (event.findings.length) {
        lines.push(`  - Findings: ${event.findings.map(cleanInline).join("; ")}`);
      }
    }
  }

  lines.push(``, `### Quality checks`);
  if (qualityRuns.length === 0) lines.push(`- No quality checks recorded for this date.`);
  else {
    for (const event of qualityRuns) {
      lines.push(`- ${formatTime(event.capturedAt)} — ${code(event.project.name)}: overall **${event.status}**.`);
      for (const check of event.checks) {
        const exit = check.exitCode === null ? "no process" : `exit ${check.exitCode}`;
        lines.push(`  - ${check.tool}: **${check.status}** (${exit})${check.note ? ` — ${cleanInline(check.note)}` : ""}`);
      }
    }
  }

  const diagnostics = uniqueDiagnostics(qualityRuns);
  lines.push(``, `### Important errors and warnings`);
  if (diagnostics.length === 0) {
    lines.push(`- No normalized errors or warnings recorded.`);
  } else {
    for (const diagnostic of diagnostics) {
      const location = diagnostic.file
        ? ` at ${code(`${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`)}`
        : "";
      lines.push(
        `- **${diagnostic.severity}** — ${code(diagnostic.project)} / ${diagnostic.tool}${location}: ${cleanInline(diagnostic.message)} (observed ${diagnostic.occurrences} ${diagnostic.occurrences === 1 ? "time" : "times"}).`,
      );
    }
  }

  lines.push(``, `### Git changes and recent commits`);
  const latestGit = new Map<string, GitActivity>();
  for (const event of gitSnapshots) latestGit.set(event.project.directory, event);
  if (latestGit.size === 0) lines.push(`- No Git snapshots recorded for this date.`);
  else {
    for (const event of latestGit.values()) {
      const result = event.result;
      if (result.status !== "available") {
        lines.push(`- ${code(event.project.name)}: ${cleanInline(result.message ?? result.status)}.`);
        continue;
      }
      lines.push(
        `- ${code(event.project.name)} — branch ${code(result.branch ?? "unknown")}; ${result.totalFileCount} changed files (latest snapshot ${formatTime(event.capturedAt)}).`,
      );
      lines.push(`  - ${result.summary.map(cleanInline).join(" ")}`);
      for (const warning of result.warnings) {
        lines.push(`  - Warning: ${cleanInline(warning)}`);
      }
      const visibleFiles = [
        ...result.staged,
        ...result.unstaged,
        ...result.untracked,
      ].filter((file) => !file.likelySecret);
      if (visibleFiles.length) {
        lines.push(`  - Paths: ${visibleFiles.slice(0, 30).map((file) => code(file.path)).join(", ")}${visibleFiles.length > 30 ? ", additional paths omitted" : ""}`);
      }
      const secretCount = [
        ...result.staged,
        ...result.unstaged,
        ...result.untracked,
      ].filter((file) => file.likelySecret).length;
      if (secretCount) lines.push(`  - ${secretCount} likely secret file path(s) detected; contents and paths omitted.`);
      if (result.recentCommits.length) {
        lines.push(`  - Recent commits: ${result.recentCommits.slice(0, 3).map((entry) => {
          const [hash, subject] = entry.split("\t");
          return `${code(hash ?? "")} ${cleanInline(subject ?? entry)}`;
        }).join("; ")}`);
      } else {
        lines.push(`  - No recent commits available.`);
      }
    }
  }

  lines.push(``, `### Unresolved issues`);
  const unresolved = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const failedChecks = qualityRuns.flatMap((event) =>
    event.checks
      .filter((check) => check.status === "failure" || check.status === "unavailable")
      .map((check) => `${event.project.name}: ${check.tool} ${check.status}`),
  );
  if (unresolved.length === 0 && failedChecks.length === 0) {
    lines.push(`- No unresolved quality errors were identified in the recorded checks. Issue resolution is not tracked.`);
  } else {
    if (unresolved.length) {
      lines.push(`- ${unresolved.length} distinct quality error(s) were observed; resolution is not tracked. See **Important errors and warnings** above.`);
    }
    for (const check of [...new Set(failedChecks)]) {
      lines.push(`- **Observed check issue:** ${cleanInline(check)}.`);
    }
  }

  lines.push(``, `## Suggested next steps`, ``);
  const recommendations = new Set<string>();
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    recommendations.add("Review the observed quality errors, then rerun the relevant checks.");
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    recommendations.add("Review the observed quality warnings.");
  }
  if (qualityRuns.some((event) => event.checks.some((check) => check.status === "unavailable"))) {
    recommendations.add("Make the configured local check tool available, then rerun the check.");
  }
  for (const event of latestGit.values()) {
    if (
      event.result.status === "available" &&
      event.result.totalFileCount > 0
    ) {
      recommendations.add("Review the listed Git changes before deciding whether to stage or commit them.");
    }
  }
  if (recommendations.size === 0) lines.push(`- No next step is suggested by the recorded findings.`);
  else for (const recommendation of recommendations) lines.push(`- ${recommendation}`);

  lines.push(``, `---`, `Generated locally from recorded application activity. No source files or reports were sent externally.`);
  return {
    date,
    generatedAt: new Date().toISOString(),
    markdown: lines.join("\n"),
    activityCounts: { scans: scans.length, qualityRuns: qualityRuns.length, gitSnapshots: gitSnapshots.length },
  };
}

export async function readActivities(dataDirectory: string): Promise<ReportActivity[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dataDirectory, "activity.json"), "utf8"),
    );
    return Array.isArray(parsed) ? (parsed as ReportActivity[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function recordActivity(
  dataDirectory: string,
  activity: ReportActivity,
): Promise<void> {
  const write = activityWriteQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const activities = await readActivities(dataDirectory);
    activities.push(activity);
    const retained = activities.slice(-maxActivityEvents);
    const destination = path.join(dataDirectory, "activity.json");
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(retained, null, 2), "utf8");
    await rename(temporary, destination);
  });
  activityWriteQueue = write.catch(() => {});
  await write;
}

export async function saveDailyReport(
  dataDirectory: string,
  report: DailyReport,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const reportsPath = path.join(dataDirectory, "reports.json");
  let reports: Record<string, DailyReport> = {};
  try {
    reports = JSON.parse(await readFile(reportsPath, "utf8")) as Record<string, DailyReport>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  reports[report.date] = report;
  const temporary = `${reportsPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(reports, null, 2), "utf8");
  await rename(temporary, reportsPath);
}

export async function readDailyReport(
  dataDirectory: string,
  date: string,
): Promise<DailyReport | null> {
  validateDate(date);
  try {
    const reports = JSON.parse(
      await readFile(path.join(dataDirectory, "reports.json"), "utf8"),
    ) as Record<string, DailyReport>;
    return reports[date] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function validateReportDate(date: string): boolean {
  try {
    validateDate(date);
    return true;
  } catch {
    return false;
  }
}

export function projectScanActivity(scan: ProjectScan, date: string): ScanActivity {
  return {
    type: "scan",
    date,
    capturedAt: new Date().toISOString(),
    project: { name: scan.name, directory: scan.directory },
    technologies: scan.technologies,
    findings: scan.findings,
  };
}

export function qualityActivity(
  name: string,
  result: QualityResult,
  date: string,
): QualityActivity {
  return {
    type: "quality",
    date,
    capturedAt: result.completedAt,
    project: { name, directory: result.project },
    status: result.status,
    checks: result.checks.map((check) => ({
      ...check,
      stdout: "",
      stderr: "",
    })),
  };
}

export function gitActivity(
  name: string,
  result: GitChangesResult,
  date: string,
): GitActivity {
  const { stagedDiff: _stagedDiff, unstagedDiff: _unstagedDiff, ...safeResult } = result;
  return {
    type: "git",
    date,
    capturedAt: result.completedAt,
    project: { name, directory: result.project },
    result: safeResult,
  };
}
