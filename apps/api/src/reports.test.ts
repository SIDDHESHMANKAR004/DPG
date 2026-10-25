import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildDailyReport,
  gitActivity,
  projectScanActivity,
  qualityActivity,
  readDailyReport,
  readActivities,
  recordActivity,
  saveDailyReport,
  type ReportActivity,
} from "./reports.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createDataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-report-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

describe("daily reports", () => {
  it("persists concise results without raw process output or diff contents", () => {
    const date = "2026-10-25";
    const project = {
      directory: "C:\\work\\sample-app",
      name: "sample-app",
      scannedAt: new Date().toISOString(),
      technologies: [],
      packageManager: null,
      scripts: {},
      gitRepository: true,
      findings: [],
      truncated: false,
    };
    const quality = qualityActivity("sample-app", {
      project: project.directory,
      status: "failure",
      completedAt: new Date().toISOString(),
      checks: [{
        tool: "ESLint",
        status: "failure",
        exitCode: 1,
        stdout: "PRIVATE_SOURCE_OUTPUT",
        stderr: "",
        outputTruncated: false,
        diagnostics: [],
      }],
    }, date);
    const git = gitActivity("sample-app", {
      status: "available",
      project: project.directory,
      branch: "main",
      staged: [],
      unstaged: [],
      untracked: [],
      totalFileCount: 0,
      fileListTruncated: false,
      recentCommits: [],
      stagedDiff: { text: "PRIVATE_DIFF_CONTENT", truncated: false },
      unstagedDiff: { text: "", truncated: false },
      summary: [],
      warnings: [],
      completedAt: new Date().toISOString(),
    }, date);

    assert.equal(quality.checks[0].stdout, "");
    assert.ok(!JSON.stringify(git).includes("PRIVATE_DIFF_CONTENT"));
    assert.equal(projectScanActivity(project, date).type, "scan");
  });

  it("generates a factual report, groups repeated diagnostics, and persists it locally", async () => {
    const dataDirectory = await createDataDirectory();
    const date = "2026-10-25";
    const project = { name: "sample-app", directory: "C:\\work\\sample-app" };
    const diagnostic = {
      severity: "error" as const,
      message: "Missing return type.",
      file: "src\\index.ts",
      line: 4,
      column: 1,
      occurrences: 1,
    };
    const events: ReportActivity[] = [
      {
        type: "scan",
        date,
        capturedAt: `${date}T08:00:00.000Z`,
        project,
        technologies: ["Node.js", "TypeScript"],
        findings: ["Root package.json found."],
      },
      {
        type: "quality",
        date,
        capturedAt: `${date}T09:00:00.000Z`,
        project,
        status: "failure",
        checks: [{
          tool: "ESLint",
          status: "failure",
          exitCode: 1,
          stdout: "source content must not be in the report",
          stderr: "",
          outputTruncated: false,
          diagnostics: [diagnostic],
        }],
      },
      {
        type: "quality",
        date,
        capturedAt: `${date}T10:00:00.000Z`,
        project,
        status: "failure",
        checks: [{
          tool: "ESLint",
          status: "failure",
          exitCode: 1,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          diagnostics: [diagnostic],
        }],
      },
      {
        type: "git",
        date,
        capturedAt: `${date}T11:00:00.000Z`,
        project,
        result: {
          status: "available",
          project: project.directory,
          branch: "main",
          staged: [],
          unstaged: [{
            path: "src/index.ts",
            status: " M",
            likelySecret: false,
          }],
          untracked: [{
            path: ".env.local",
            status: "??",
            likelySecret: true,
          }],
          totalFileCount: 2,
          fileListTruncated: false,
          recentCommits: ["abc123\tInitial setup\t2 hours ago"],
          summary: ["1 unstaged file, 1 untracked file."],
          warnings: ["Likely secret file paths detected (1); their diff contents are excluded."],
          completedAt: `${date}T11:00:00.000Z`,
        },
      },
      {
        type: "scan",
        date: "2026-10-24",
        capturedAt: "2026-10-24T12:00:00.000Z",
        project: { name: "previous-day", directory: "C:\\work\\previous-day" },
        technologies: [],
        findings: [],
      },
    ];

    await Promise.all(events.map((event) => recordActivity(dataDirectory, event)));
    const storedEvents = await readActivities(dataDirectory);
    const report = buildDailyReport(date, storedEvents);

    assert.deepEqual(report.activityCounts, { scans: 1, qualityRuns: 2, gitSnapshots: 1 });
    assert.equal(report.markdown.split("Missing return type.").length - 1, 1);
    assert.match(report.markdown, /observed 2 times/);
    assert.match(report.markdown, /No source files or reports were sent externally/);
    assert.doesNotMatch(report.markdown, /source content must not be in the report/);
    assert.doesNotMatch(report.markdown, /\.env\.local/);
    assert.match(report.markdown, /Initial setup/);
    assert.match(report.markdown, /Review the observed quality errors/);

    await saveDailyReport(dataDirectory, report);
    const saved = await readDailyReport(dataDirectory, date);
    assert.equal(saved?.markdown, report.markdown);
    assert.equal(await readDailyReport(dataDirectory, "2026-10-23"), null);
  });

  it("marks dates with no recorded activity instead of inventing activity", () => {
    const report = buildDailyReport("2026-10-25", []);

    assert.deepEqual(report.activityCounts, { scans: 0, qualityRuns: 0, gitSnapshots: 0 });
    assert.match(report.markdown, /No project scans recorded/);
    assert.match(report.markdown, /No quality checks recorded/);
    assert.match(report.markdown, /No Git snapshots recorded/);
    assert.match(report.markdown, /No next step is suggested/);
  });
});
