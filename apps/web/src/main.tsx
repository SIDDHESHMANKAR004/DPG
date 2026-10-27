import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import React from "react";
import ReactDOM from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles.css";
import {
  LocalAgentConnectionPanel,
  LocalAgentProvider,
  useLocalAgent,
} from "./localAgent.js";
import {
  LocalAgentGitPanel,
  LocalAgentProjectsPanel,
  LocalAgentQualityPanel,
} from "./localAgentPanels.js";

const sections = [
  { id: "overview", label: "Overview", marker: "01" },
  { id: "projects", label: "Projects", marker: "02" },
  { id: "quality", label: "Errors & Quality", marker: "03" },
  { id: "git", label: "Git Changes", marker: "04" },
  { id: "reports", label: "Daily Reports", marker: "05" },
] as const;

type SectionId = (typeof sections)[number]["id"];
type ApiStatus = "loading" | "online" | "unavailable";

interface ProjectScan {
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

interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  occurrences: number;
}

interface CheckResult {
  tool: "ESLint" | "TypeScript";
  status: "success" | "failure" | "unavailable" | "skipped" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  diagnostics: Diagnostic[];
  note?: string;
}

interface QualityResult {
  project: string;
  checks: CheckResult[];
  status: "success" | "failure" | "unavailable" | "cancelled";
  completedAt: string;
}

type QualityViewState = "idle" | "loading" | QualityResult["status"];

interface GitFileChange {
  path: string;
  previousPath?: string;
  status: string;
  likelySecret: boolean;
}

interface GitDiffPreview {
  text: string;
  truncated: boolean;
}

interface GitChangesResult {
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

type GitViewState = "idle" | "loading" | GitChangesResult["status"];

interface DailyReport {
  date: string;
  generatedAt: string;
  markdown: string;
  activityCounts: { scans: number; qualityRuns: number; gitSnapshots: number };
}

const features: {
  id: Exclude<SectionId, "overview">;
  title: string;
  description: string;
}[] = [
  {
    id: "projects",
    title: "Projects",
    description: "Scan a local project directory and view its detected setup.",
  },
  {
    id: "quality",
    title: "Errors & Quality",
    description: "Run configured, read-only ESLint and TypeScript checks.",
  },
  {
    id: "git",
    title: "Git Changes",
    description: "Review branch, working-tree changes, and recent commits.",
  },
  {
    id: "reports",
    title: "Daily Reports",
    description: "Generate and save a factual Markdown summary of recorded activity.",
  },
];

function isProjectScan(value: unknown): value is ProjectScan {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.directory === "string" &&
    typeof project.name === "string" &&
    typeof project.scannedAt === "string" &&
    Array.isArray(project.technologies) &&
    project.technologies.every((item) => typeof item === "string") &&
    (typeof project.packageManager === "string" || project.packageManager === null) &&
    typeof project.scripts === "object" &&
    project.scripts !== null &&
    !Array.isArray(project.scripts) &&
    typeof project.gitRepository === "boolean" &&
    Array.isArray(project.findings) &&
    project.findings.every((item) => typeof item === "string") &&
    typeof project.truncated === "boolean"
  );
}

async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return `Request failed with HTTP ${response.status}.`;
}

function getLocalDate(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function isDailyReport(value: unknown): value is DailyReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.activityCounts !== "object" || report.activityCounts === null) return false;
  const counts = report.activityCounts as Record<string, unknown>;
  return (
    typeof report.date === "string" &&
    typeof report.generatedAt === "string" &&
    typeof report.markdown === "string" &&
    typeof counts.scans === "number" &&
    typeof counts.qualityRuns === "number" &&
    typeof counts.gitSnapshots === "number"
  );
}

function DailyReportsSection() {
  const [date, setDate] = useState(getLocalDate);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReport(null);
    fetch(`/api/reports/${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("report" in payload)) {
          throw new Error("The saved report response was invalid.");
        }
        if (payload.report !== null && !isDailyReport(payload.report)) {
          throw new Error("The saved report response was invalid.");
        }
        setReport(payload.report);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not load the saved report.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [date]);

  async function generateReport() {
    setError("");
    setGenerating(true);
    try {
      const response = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("report" in payload) ||
        !isDailyReport(payload.report)
      ) {
        throw new Error("The generated report response was invalid.");
      }
      setReport(payload.report);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate the report.");
    } finally {
      setGenerating(false);
    }
  }

  function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `developer-work-report-${report.date}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <section className="scanner-panel report-controls">
        <h2>Daily activity report</h2>
        <p>Generated locally from project scans, quality checks, and Git snapshots recorded by this app.</p>
        <div className="report-actions">
          <div>
            <label className="form-label" htmlFor="report-date">Report date (local)</label>
            <input
              id="report-date"
              className="form-control"
              type="date"
              value={date}
              max={getLocalDate()}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="report-buttons">
            <button
              className="btn btn-success"
              type="button"
              onClick={generateReport}
              disabled={!date || loading || generating}
            >
              {generating ? "Generating…" : "Generate and save"}
            </button>
            <button
              className="btn btn-outline-secondary"
              type="button"
              onClick={downloadReport}
              disabled={!report}
            >
              Download .md
            </button>
          </div>
        </div>
        <p className="report-privacy-note">Reports and activity records stay on this machine; nothing is sent externally.</p>
        {error && <div className="alert alert-warning mb-0 mt-3" role="alert">{error}</div>}
      </section>

      {loading ? (
        <p className="projects-message">Loading saved report…</p>
      ) : report ? (
        <>
          <div className="report-counts" aria-label="Recorded activity counts">
            <span><strong>{report.activityCounts.scans}</strong> scans</span>
            <span><strong>{report.activityCounts.qualityRuns}</strong> quality runs</span>
            <span><strong>{report.activityCounts.gitSnapshots}</strong> Git snapshots</span>
          </div>
          <section className="report-preview" aria-label="Daily report Markdown">
            <pre>{report.markdown}</pre>
          </section>
        </>
      ) : (
        <section className="projects-empty">
          <h3>No saved report for {date || "this date"}</h3>
          <p>Generate a report to save the activity recorded for this local date.</p>
        </section>
      )}
    </>
  );
}

function isQualityResult(value: unknown): value is QualityResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.project === "string" &&
    Array.isArray(result.checks) &&
    result.checks.every((check) => {
      if (typeof check !== "object" || check === null) return false;
      const item = check as Record<string, unknown>;
      return (
        (item.tool === "ESLint" || item.tool === "TypeScript") &&
        ["success", "failure", "unavailable", "skipped", "cancelled"].includes(String(item.status)) &&
        (typeof item.exitCode === "number" || item.exitCode === null) &&
        typeof item.stdout === "string" &&
        typeof item.stderr === "string" &&
        typeof item.outputTruncated === "boolean" &&
        Array.isArray(item.diagnostics) &&
        item.diagnostics.every((diagnostic) => {
          if (typeof diagnostic !== "object" || diagnostic === null) return false;
          const entry = diagnostic as Record<string, unknown>;
          return (
            (entry.severity === "error" || entry.severity === "warning") &&
            typeof entry.message === "string" &&
            typeof entry.occurrences === "number"
          );
        })
      );
    }) &&
    typeof result.completedAt === "string" &&
    ["success", "failure", "unavailable", "cancelled"].includes(String(result.status))
  );
}

function QualitySection() {
  const [projects, setProjects] = useState<ProjectScan[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [viewState, setViewState] = useState<QualityViewState>("idle");
  const [result, setResult] = useState<QualityResult | null>(null);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("projects" in payload) ||
          !Array.isArray(payload.projects) ||
          !payload.projects.every(isProjectScan)
        ) {
          throw new Error("The projects response was invalid.");
        }
        const loadedProjects = payload.projects.filter(isProjectScan);
        setProjects(loadedProjects);
        setSelectedDirectory((selected) => selected || loadedProjects[0]?.directory || "");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not load saved projects.");
      })
      .finally(() => setLoadingProjects(false));
    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
  }, []);

  async function runChecks() {
    if (!selectedDirectory) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setError("");
    setResult(null);
    setViewState("loading");
    try {
      const response = await fetch("/api/projects/quality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: selectedDirectory, localDate: getLocalDate() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("result" in payload) ||
        !isQualityResult(payload.result)
      ) {
        throw new Error("The quality-check response was invalid.");
      }
      setResult(payload.result);
      setViewState(payload.result.status);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setViewState("cancelled");
      } else {
        setError(reason instanceof Error ? reason.message : "Quality checks could not be completed.");
        setViewState("failure");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function cancelChecks() {
    controllerRef.current?.abort();
    setViewState("cancelled");
  }

  const selectedProject = projects.find((project) => project.directory === selectedDirectory);

  return (
    <>
      <section className="scanner-panel quality-controls">
        <h2>Read-only checks</h2>
        <p>Run local ESLint and TypeScript tools with fixed arguments. Project scripts are never executed.</p>
        {loadingProjects ? (
          <p className="projects-message">Loading saved projects…</p>
        ) : projects.length === 0 ? (
          <p className="projects-message">Scan and save a project before running quality checks.</p>
        ) : (
          <div className="quality-actions">
            <label className="visually-hidden" htmlFor="quality-project">Project</label>
            <select
              id="quality-project"
              className="form-select"
              value={selectedDirectory}
              onChange={(event) => {
                setSelectedDirectory(event.target.value);
                setResult(null);
                setViewState("idle");
              }}
              disabled={viewState === "loading"}
            >
              {projects.map((project) => (
                <option value={project.directory} key={project.directory}>{project.name}</option>
              ))}
            </select>
            {viewState === "loading" ? (
              <button className="btn btn-outline-secondary" type="button" onClick={cancelChecks}>
                Cancel checks
              </button>
            ) : (
              <button className="btn btn-success" type="button" onClick={runChecks}>
                Run checks
              </button>
            )}
          </div>
        )}
        {selectedProject && <p className="project-path quality-project-path">{selectedProject.directory}</p>}
        {error && <div className="alert alert-warning mb-0 mt-3" role="alert">{error}</div>}
        {viewState !== "idle" && (
          <div className={`quality-state ${viewState}`} role="status" aria-live="polite">
            {viewState === "loading" && "Checks are running…"}
            {viewState === "success" && "Checks completed successfully."}
            {viewState === "failure" && "One or more checks failed."}
            {viewState === "unavailable" && "No configured local checks are available."}
            {viewState === "cancelled" && "Checks cancelled."}
          </div>
        )}
      </section>

      {result && (
        <div className="quality-results">
          {result.checks.map((check) => (
            <article className="check-card" key={check.tool}>
              <header className="check-header">
                <div>
                  <h3>{check.tool}</h3>
                  <span className={`check-status ${check.status}`}>{check.status}</span>
                </div>
                <span className="check-exit-code">
                  {check.exitCode === null ? "No process" : `Exit code ${check.exitCode}`}
                </span>
              </header>
              {check.note && <p className="check-note">{check.note}</p>}
              {check.diagnostics.length > 0 ? (
                <ul className="diagnostic-list">
                  {check.diagnostics.map((diagnostic, index) => (
                    <li className="diagnostic" key={`${diagnostic.file ?? ""}-${diagnostic.line ?? ""}-${diagnostic.column ?? ""}-${index}`}>
                      <span className={`diagnostic-severity ${diagnostic.severity}`}>
                        {diagnostic.severity}
                        {diagnostic.occurrences > 1 && ` ×${diagnostic.occurrences}`}
                      </span>
                      <div className="diagnostic-content">
                        <p>{diagnostic.message}</p>
                        {(diagnostic.file || diagnostic.line || diagnostic.column) && (
                          <span className="diagnostic-location">
                            {diagnostic.file ?? "Unknown file"}
                            {diagnostic.line && `:${diagnostic.line}`}
                            {diagnostic.column && `:${diagnostic.column}`}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="no-diagnostics">
                  {check.status === "success" ? "No diagnostics." : "No diagnostics were reported."}
                </p>
              )}
              {(check.stdout || check.stderr) && (
                <details className="check-output">
                  <summary>Captured output{check.outputTruncated ? " (truncated)" : ""}</summary>
                  {check.stdout && <pre>{check.stdout}</pre>}
                  {check.stderr && <pre>{check.stderr}</pre>}
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      <LocalAgentQualityPanel />
    </>
  );
}

function isGitChangesResult(value: unknown): value is GitChangesResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    ["available", "not-git", "unavailable", "failure"].includes(String(result.status)) &&
    typeof result.project === "string" &&
    (typeof result.branch === "string" || result.branch === null) &&
    ["staged", "unstaged", "untracked"].every(
      (key) =>
        Array.isArray(result[key]) &&
        result[key].every((file: unknown) => {
          if (typeof file !== "object" || file === null) return false;
          const item = file as Record<string, unknown>;
          return (
            typeof item.path === "string" &&
            typeof item.status === "string" &&
            typeof item.likelySecret === "boolean"
          );
        }),
    ) &&
    typeof result.totalFileCount === "number" &&
    typeof result.fileListTruncated === "boolean" &&
    Array.isArray(result.recentCommits) &&
    result.recentCommits.every((item) => typeof item === "string") &&
    ["stagedDiff", "unstagedDiff"].every((key) => {
      const diff = result[key];
      return (
        typeof diff === "object" &&
        diff !== null &&
        "text" in diff &&
        typeof diff.text === "string" &&
        "truncated" in diff &&
        typeof diff.truncated === "boolean"
      );
    }) &&
    Array.isArray(result.summary) &&
    result.summary.every((item) => typeof item === "string") &&
    Array.isArray(result.warnings) &&
    result.warnings.every((item) => typeof item === "string") &&
    typeof result.completedAt === "string"
  );
}

function GitFileList({ title, files }: { title: string; files: GitFileChange[] }) {
  return (
    <section className="git-file-section">
      <div className="git-file-heading">
        <h4>{title}</h4>
        <span>{files.length}</span>
      </div>
      {files.length === 0 ? (
        <p className="git-empty-list">None</p>
      ) : (
        <ul className="git-file-list">
          {files.map((file, index) => (
            <li key={`${file.path}-${file.previousPath ?? ""}-${index}`}>
              <code>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</code>
              {file.likelySecret && <span className="secret-warning">Likely secret — diff hidden</span>}
              {!file.likelySecret && <span className="git-file-status">{file.status.trim() || "??"}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GitChangesSection() {
  const [projects, setProjects] = useState<ProjectScan[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [viewState, setViewState] = useState<GitViewState>("idle");
  const [result, setResult] = useState<GitChangesResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("projects" in payload) ||
          !Array.isArray(payload.projects) ||
          !payload.projects.every(isProjectScan)
        ) {
          throw new Error("The projects response was invalid.");
        }
        const loadedProjects = payload.projects.filter(isProjectScan);
        setProjects(loadedProjects);
        setSelectedDirectory((selected) => selected || loadedProjects[0]?.directory || "");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not load saved projects.");
      })
      .finally(() => setLoadingProjects(false));
    return () => controller.abort();
  }, []);

  async function loadGitChanges() {
    if (!selectedDirectory) return;
    setError("");
    setResult(null);
    setViewState("loading");
    try {
      const response = await fetch("/api/projects/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: selectedDirectory, localDate: getLocalDate() }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("result" in payload) ||
        !isGitChangesResult(payload.result)
      ) {
        throw new Error("The Git changes response was invalid.");
      }
      setResult(payload.result);
      setViewState(payload.result.status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Git changes could not be loaded.");
      setViewState("failure");
    }
  }

  return (
    <>
      <section className="scanner-panel quality-controls">
        <h2>Repository changes</h2>
        <p>Read-only Git status and recent history for a scanned project.</p>
        {loadingProjects ? (
          <p className="projects-message">Loading saved projects…</p>
        ) : projects.length === 0 ? (
          <p className="projects-message">Scan and save a project before viewing Git changes.</p>
        ) : (
          <div className="quality-actions">
            <label className="visually-hidden" htmlFor="git-project">Project</label>
            <select
              id="git-project"
              className="form-select"
              value={selectedDirectory}
              onChange={(event) => {
                setSelectedDirectory(event.target.value);
                setResult(null);
                setViewState("idle");
              }}
              disabled={viewState === "loading"}
            >
              {projects.map((project) => (
                <option value={project.directory} key={project.directory}>{project.name}</option>
              ))}
            </select>
            <button
              className="btn btn-success"
              type="button"
              onClick={loadGitChanges}
              disabled={!selectedDirectory || viewState === "loading"}
            >
              {viewState === "loading" ? "Loading…" : "Refresh changes"}
            </button>
          </div>
        )}
        {error && <div className="alert alert-warning mb-0 mt-3" role="alert">{error}</div>}
        {viewState === "loading" && <div className="quality-state loading" role="status">Reading Git status…</div>}
      </section>

      {result?.status === "not-git" || result?.status === "unavailable" || result?.status === "failure" ? (
        <section className="projects-empty" role="status">
          <h3>{result.status === "not-git" ? "No Git repository" : "Git status unavailable"}</h3>
          <p>{result.message}</p>
        </section>
      ) : result?.status === "available" ? (
        <>
          <section className="git-overview-card">
            <div>
              <span className="git-overline">CURRENT BRANCH</span>
              <h2>{result.branch}</h2>
            </div>
            <div className="git-total-count">
              <strong>{result.totalFileCount}</strong>
              <span>changed entries</span>
            </div>
          </section>

          <section className="git-summary-card">
            <h3>Change summary</h3>
            {result.summary.map((summary) => <p key={summary}>{summary}</p>)}
          </section>

          {result.warnings.map((warning) => (
            <div className="alert alert-warning git-warning" role="alert" key={warning}>{warning}</div>
          ))}

          <div className="git-file-grid">
            <GitFileList title="Staged" files={result.staged} />
            <GitFileList title="Unstaged" files={result.unstaged} />
            <GitFileList title="Untracked" files={result.untracked} />
          </div>

          <div className="git-diff-grid">
            {([
              ["Staged diff preview", result.stagedDiff],
              ["Unstaged diff preview", result.unstagedDiff],
            ] as const).map(([title, diff]) => (
              <details className="git-diff-card" key={title}>
                <summary>{title}{diff.truncated ? " (truncated)" : ""}</summary>
                {diff.text ? (
                  <pre>{diff.text}</pre>
                ) : (
                  <p>No preview available. Untracked and likely secret files are not shown.</p>
                )}
              </details>
            ))}
          </div>

          <section className="git-commits-card">
            <h3>Recent commits</h3>
            {result.recentCommits.length ? (
              <ul>
                {result.recentCommits.map((commit, index) => {
                  const [hash, subject, date] = commit.split("\t");
                  return (
                    <li key={`${hash}-${index}`}>
                      <code>{hash}</code><span>{subject}</span><time>{date}</time>
                    </li>
                  );
                })}
              </ul>
            ) : <p>No commits available yet.</p>}
          </section>
        </>
      ) : null}
      <LocalAgentGitPanel />
    </>
  );
}

function ProjectsSection() {
  const [directory, setDirectory] = useState("");
  const [projects, setProjects] = useState<ProjectScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("projects" in payload) ||
          !Array.isArray(payload.projects) ||
          !payload.projects.every(isProjectScan)
        ) {
          throw new Error("The projects response was invalid.");
        }
        setProjects(payload.projects);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not load saved projects.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function scanDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setScanning(true);
    try {
      const response = await fetch("/api/projects/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: directory.trim(), localDate: getLocalDate() }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("project" in payload)
      ) {
        throw new Error("The scan response was invalid.");
      }
      const project = payload.project;
      if (!isProjectScan(project)) throw new Error("The scan response was invalid.");
      setProjects((current) => [
        project,
        ...current.filter((savedProject) => savedProject.directory !== project.directory),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not scan that directory.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      <LocalAgentProjectsPanel />
      <section className="scanner-panel">
        <h2>Scan a project</h2>
        <p>Enter the absolute path to a project directory. Only that directory is scanned.</p>
        <form className="scanner-form" onSubmit={scanDirectory}>
          <label className="visually-hidden" htmlFor="project-directory">Project directory path</label>
          <input
            id="project-directory"
            className="form-control"
            type="text"
            autoComplete="off"
            placeholder="C:\\Users\\you\\source\\my-project"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            required
          />
          <button className="btn btn-success" type="submit" disabled={scanning}>
            {scanning ? "Scanning…" : "Scan directory"}
          </button>
        </form>
        <p className="scanner-note">
          Scan reads project configuration only; it skips secrets, dependency folders, and build output.
          Project scripts are never run.
        </p>
        {error && <div className="alert alert-warning mb-0 mt-3" role="alert">{error}</div>}
      </section>

      <div className="project-list-heading">
        <h2>Saved projects</h2>
        <span>{projects.length.toString().padStart(2, "0")}</span>
      </div>

      {loading ? (
        <p className="projects-message">Loading saved project metadata…</p>
      ) : projects.length === 0 ? (
        <section className="projects-empty">
          <h3>No projects scanned</h3>
          <p>Enter a local project path above to inspect its configuration.</p>
        </section>
      ) : (
        <div className="saved-projects">
          {projects.map((project) => (
            <article className="saved-project" key={project.directory}>
              <header className="saved-project-header">
                <div>
                  <h3>{project.name}</h3>
                  <p className="project-path">{project.directory}</p>
                </div>
                <span className={`git-status ${project.gitRepository ? "is-git" : ""}`}>
                  {project.gitRepository ? "Git repository" : "Not a Git repository"}
                </span>
              </header>
              <div className="project-details">
                <div>
                  <h4>Detected technologies</h4>
                  <div className="technology-list">
                    {project.technologies.length > 0
                      ? project.technologies.map((technology) => (
                          <span className="technology-badge" key={technology}>{technology}</span>
                        ))
                      : <span className="detail-muted">None detected</span>}
                  </div>
                </div>
                <div>
                  <h4>Configuration findings</h4>
                  <ul className="finding-list">
                    {project.findings.map((finding) => <li key={finding}>{finding}</li>)}
                    {project.packageManager && <li>Package manager: {project.packageManager}</li>}
                  </ul>
                </div>
                <div>
                  <h4>Available scripts <span className="not-executed">not run</span></h4>
                  {Object.keys(project.scripts).length > 0 ? (
                    <ul className="script-list">
                      {Object.entries(project.scripts).map(([name, command]) => (
                        <li key={name}><code>{name}</code><span>{command}</span></li>
                      ))}
                    </ul>
                  ) : <p className="detail-muted">No scripts found.</p>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("loading");
  const { status: localAgentStatus } = useLocalAgent();

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health check returned HTTP ${response.status}`);
        }
        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("status" in payload) ||
          payload.status !== "ok"
        ) {
          throw new Error("Health check returned an unexpected response");
        }
        setApiStatus("online");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setApiStatus("unavailable");
      });

    return () => controller.abort();
  }, []);

  const currentSection = sections.find(({ id }) => id === activeSection)!;
  const currentFeature = features.find(({ id }) => id === activeSection);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setActiveSection("overview")}>
          <span className="brand-mark">D</span>
          <span>
            <strong>devmate</strong>
            <small>WORK ASSISTANT</small>
          </span>
        </a>

        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          {sections.map((section) => (
            <button
              key={section.id}
              className={`nav-item${activeSection === section.id ? " active" : ""}`}
              type="button"
              aria-current={activeSection === section.id ? "page" : undefined}
              onClick={() => setActiveSection(section.id)}
            >
              <span className="nav-marker">{section.marker}</span>
              {section.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className={`local-indicator ${localAgentStatus === "connected" ? "" : "disconnected"}`} />
          <span>Local Agent {localAgentStatus}</span>
        </div>
      </aside>

      <main className="main-content">
        {/* <header className="topbar">
          <span className="breadcrumb">Workspace <span>/</span> {currentSection.label}</span>
          <span className="local-badge"><span className="local-indicator" /> Local-first</span>
        </header>*/}

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">DEVELOPER WORKSPACE</div>
              <h1>{activeSection === "overview" ? "Overview" : currentSection.label}</h1>
              <p>
                {activeSection === "overview"
                  ? "A clear view of your development workspace."
                  : currentFeature?.description}
              </p>
            </div>
          </div>

          {activeSection === "overview" ? (
            <>
              <section className="connection-card" aria-live="polite">
                <div className="connection-icon">API</div>
                <div className="connection-copy">
                  <h2>Backend connection</h2>
                  <p>
                    {apiStatus === "online"
                      ? "The local API is responding normally."
                      : apiStatus === "loading"
                        ? "Checking the local API…"
                        : "The local API is unavailable. Start the backend to restore the connection."}
                  </p>
                </div>
                <span className={`status-pill ${apiStatus}`}>
                  <span className="status-dot" />
                  {apiStatus === "online"
                    ? "Connected"
                    : apiStatus === "loading"
                      ? "Checking"
                      : "Unavailable"}
                </span>
              </section>
              <LocalAgentConnectionPanel />

              <div className="section-heading">
                <div>
                  <h2>Workspace tools</h2>
                  <p>Feature availability</p>
                </div>
                <span className="section-count">04 SECTIONS</span>
              </div>

              <div className="row g-3">
                {features.map((feature) => (
                  <div className="col-12 col-md-6" key={feature.id}>
                    <button
                      type="button"
                      className="feature-card text-start w-100"
                      onClick={() => setActiveSection(feature.id)}
                    >
                      <div className="feature-card-top">
                        <span className="feature-marker">
                          {sections.find(({ id }) => id === feature.id)?.marker}
                        </span>
                        <span className="availability">
                          {feature.id === "projects" ||
                          feature.id === "quality" ||
                          feature.id === "git" ||
                          feature.id === "reports"
                            ? "Available"
                            : "Not available yet"}
                        </span>
                      </div>
                      <h3>{feature.title}</h3>
                      <p>{feature.description}</p>
                      <span className="feature-link">View section <span aria-hidden="true">→</span></span>
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : activeSection === "quality" ? (
            <QualitySection />
          ) : activeSection === "git" ? (
            <GitChangesSection />
          ) : activeSection === "reports" ? (
            <DailyReportsSection />
          ) : activeSection === "projects" ? (
            <ProjectsSection />
          ) : (
            <section className="unavailable-panel">
              <div className="unavailable-icon" aria-hidden="true">—</div>
              <span className="availability">Not available yet</span>
              <h2>{currentFeature?.title}</h2>
              <p>{currentFeature?.description}</p>
              <p className="unavailable-note">No project data is being shown in this section.</p>
            </section>
          )}

          <footer className="page-footer">
            <span>Developer Work Assistant</span>
            <span>Runs locally on your machine</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocalAgentProvider>
      <App />
    </LocalAgentProvider>
  </React.StrictMode>,
);
