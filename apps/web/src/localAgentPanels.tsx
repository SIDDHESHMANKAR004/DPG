import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  LocalAgentConnectionPanel,
  useLocalAgent,
} from "./localAgent.js";
import type {
  AgentGitChanges,
  AgentQuality,
  RegisteredAgentProject,
} from "./localAgent.js";

function ProjectSelector({
  projects,
  selectedId,
  onChange,
  id,
}: {
  projects: RegisteredAgentProject[];
  selectedId: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <>
      <label className="visually-hidden" htmlFor={id}>Local Agent project</label>
      <select
        id={id}
        className="form-select"
        value={selectedId}
        onChange={(event) => onChange(event.target.value)}
      >
        {projects.map(({ id: projectId, project }) => (
          <option value={projectId} key={projectId}>{project.name}</option>
        ))}
      </select>
    </>
  );
}

export function LocalAgentProjectsPanel() {
  const { status, projects, registerProject } = useLocalAgent();
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await registerProject(directory.trim());
      setDirectory("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not register this directory.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="local-agent-projects scanner-panel">
      <div className="agent-panel-heading">
        <div>
          <h2>Projects on this computer</h2>
          <p>These paths are scanned by the Local Agent, not by the hosted API.</p>
        </div>
        <span className={`agent-inline-status ${status}`}>{status}</span>
      </div>
      {status === "disconnected" ? (
        <>
          <p className="agent-disconnected-note">
            The agent is not connected. Start it with <code>npm run dev:agent</code>, then connect using its session token.
          </p>
          <LocalAgentConnectionPanel />
        </>
      ) : (
        <>
          <form className="scanner-form" onSubmit={addProject}>
            <label className="visually-hidden" htmlFor="agent-project-directory">Local project directory</label>
            <input
              id="agent-project-directory"
              className="form-control"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="Paste an absolute local project path"
              autoComplete="off"
              required
            />
            <button className="btn btn-success" type="submit" disabled={busy}>
              {busy ? "Scanning…" : "Register and scan"}
            </button>
          </form>
          <p className="scanner-note">Only paths you submit are registered. UNC/network paths are rejected; project scripts are not run while scanning.</p>
          {error && <div className="alert alert-warning mt-3 mb-0" role="alert">{error}</div>}
          {projects.length === 0 ? (
            <p className="projects-message mt-3 mb-0">No project folders registered with this agent session.</p>
          ) : (
            <div className="agent-project-list">
              {projects.map(({ id, project }) => (
                <article className="agent-project-card" key={id}>
                  <h3>{project.name}</h3>
                  <p className="project-path">{project.directory}</p>
                  <div className="technology-list">
                    {project.technologies.length
                      ? project.technologies.map((technology) => (
                          <span className="technology-badge" key={technology}>{technology}</span>
                        ))
                      : <span className="detail-muted">No technologies detected</span>}
                  </div>
                  <ul className="finding-list mt-2">
                    {project.findings.map((finding) => <li key={finding}>{finding}</li>)}
                  </ul>
                  <p className="agent-project-meta">
                    {project.gitRepository ? "Git repository detected" : "No Git repository detected"}
                    {" · "}Scanned {new Date(project.scannedAt).toLocaleString()}
                  </p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function LocalAgentQualityPanel() {
  const { status, projects, collectErrors, runQuality } = useLocalAgent();
  const [selectedId, setSelectedId] = useState("");
  const [errors, setErrors] = useState<{ diagnostics: { severity: string; message: string; file?: string; line?: number; column?: number; occurrences: number; tool?: string }[]; status: string } | null>(null);
  const [quality, setQuality] = useState<AgentQuality | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? "");
      setErrors(null);
      setQuality(null);
    }
  }, [projects, selectedId]);

  async function perform(action: "errors" | "quality" | "build") {
    if (!selectedId) return;
    if (
      action === "build" &&
      !window.confirm(
        "Run this project's package.json build script? Project-defined scripts can execute code and modify files. Continue only if you trust this project.",
      )
    ) return;
    setBusy(action);
    setError("");
    try {
      if (action === "errors") setErrors(await collectErrors(selectedId));
      else setQuality(await runQuality(selectedId, action === "build", action === "build"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Local quality operation failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="scanner-panel agent-tool-panel">
      <div className="agent-panel-heading">
        <div>
          <h2>Local Agent checks</h2>
          <p>Run fixed-argument ESLint and TypeScript checks against a registered local project.</p>
        </div>
        <span className={`agent-inline-status ${status}`}>{status}</span>
      </div>
      {status !== "connected" ? (
        <p className="agent-disconnected-note">Connect the Local Agent from Overview or Projects to run checks on this computer.</p>
      ) : projects.length === 0 ? (
        <p className="projects-message">Register a local project in Projects before running checks.</p>
      ) : (
        <>
          <div className="quality-actions">
            <ProjectSelector
              id="agent-quality-project"
              projects={projects}
              selectedId={selectedId}
              onChange={(value) => {
                setSelectedId(value);
                setErrors(null);
                setQuality(null);
              }}
            />
            <button className="btn btn-outline-success" type="button" disabled={Boolean(busy)} onClick={() => perform("errors")}>
              {busy === "errors" ? "Collecting…" : "Collect errors"}
            </button>
            <button className="btn btn-success" type="button" disabled={Boolean(busy)} onClick={() => perform("quality")}>
              {busy === "quality" ? "Running…" : "Run checks"}
            </button>
            <button className="btn btn-outline-secondary" type="button" disabled={Boolean(busy)} onClick={() => perform("build")}>
              {busy === "build" ? "Building…" : "Run build…"}
            </button>
          </div>
          {error && <div className="alert alert-warning mt-3 mb-0" role="alert">{error}</div>}
          {errors && (
            <div className="agent-result-block">
              <h3>Collected diagnostics <span className="check-status">{errors.status}</span></h3>
              {errors.diagnostics.length ? (
                <ul className="diagnostic-list">
                  {errors.diagnostics.map((diagnostic, index) => (
                    <li className="diagnostic" key={`${diagnostic.tool}-${diagnostic.file}-${diagnostic.line}-${index}`}>
                      <span className={`diagnostic-severity ${diagnostic.severity}`}>{diagnostic.severity}</span>
                      <div className="diagnostic-content">
                        <p>{diagnostic.message}</p>
                        <span className="diagnostic-location">
                          {diagnostic.tool}
                          {diagnostic.file ? ` · ${diagnostic.file}` : ""}
                          {diagnostic.line ? `:${diagnostic.line}` : ""}
                          {diagnostic.column ? `:${diagnostic.column}` : ""}
                          {diagnostic.occurrences > 1 ? ` · ${diagnostic.occurrences} occurrences` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="detail-muted">No diagnostics reported.</p>}
            </div>
          )}
          {quality && (
            <div className="agent-result-block">
              <h3>Quality results</h3>
              {quality.checks.checks.map((check) => (
                <div className="agent-check-row" key={check.tool}>
                  <strong>{check.tool}</strong>
                  <span className={`check-status ${check.status}`}>{check.status}</span>
                  {check.exitCode !== null && <span className="check-exit-code">Exit {check.exitCode}</span>}
                  {check.note && <p>{check.note}</p>}
                </div>
              ))}
              {quality.build && (
                <div className="agent-check-row">
                  <strong>Build</strong>
                  <span className={`check-status ${quality.build.status}`}>{quality.build.status}</span>
                  {quality.build.exitCode !== null && <span className="check-exit-code">Exit {quality.build.exitCode}</span>}
                  {quality.build.note && <p>{quality.build.note}</p>}
                </div>
              )}
              {quality.checks.checks.some((check) => check.diagnostics.length > 0) && (
                <ul className="diagnostic-list">
                  {quality.checks.checks.flatMap((check) =>
                    check.diagnostics.map((diagnostic, index) => (
                      <li className="diagnostic" key={`${check.tool}-${diagnostic.file}-${diagnostic.line}-${index}`}>
                        <span className={`diagnostic-severity ${diagnostic.severity}`}>{diagnostic.severity}</span>
                        <div className="diagnostic-content">
                          <p>{diagnostic.message}</p>
                          <span className="diagnostic-location">
                            {check.tool}{diagnostic.file ? ` · ${diagnostic.file}` : ""}
                            {diagnostic.line ? `:${diagnostic.line}` : ""}
                            {diagnostic.column ? `:${diagnostic.column}` : ""}
                          </span>
                        </div>
                      </li>
                    )),
                  )}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function LocalAgentGitPanel() {
  const { status, projects, getGitChanges } = useLocalAgent();
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<AgentGitChanges | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? "");
      setResult(null);
    }
  }, [projects, selectedId]);

  async function refresh() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      setResult(await getGitChanges(selectedId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read local Git changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="scanner-panel agent-tool-panel">
      <div className="agent-panel-heading">
        <div>
          <h2>Local Agent Git</h2>
          <p>Read-only status and recent history from a registered project on this computer.</p>
        </div>
        <span className={`agent-inline-status ${status}`}>{status}</span>
      </div>
      {status !== "connected" ? (
        <p className="agent-disconnected-note">Connect the Local Agent from Overview or Projects to inspect local repositories.</p>
      ) : projects.length === 0 ? (
        <p className="projects-message">Register a local project in Projects before viewing Git changes.</p>
      ) : (
        <>
          <div className="quality-actions">
            <ProjectSelector
              id="agent-git-project"
              projects={projects}
              selectedId={selectedId}
              onChange={(value) => {
                setSelectedId(value);
                setResult(null);
              }}
            />
            <button className="btn btn-success" type="button" disabled={busy} onClick={refresh}>
              {busy ? "Reading…" : "Refresh Git"}
            </button>
          </div>
          {error && <div className="alert alert-warning mt-3 mb-0" role="alert">{error}</div>}
          {result && (
            <div className="agent-result-block">
              {result.status !== "available" ? (
                <p>{result.message ?? "Git status unavailable."}</p>
              ) : (
                <>
                  <h3>{result.branch ?? "Unknown branch"} · {result.totalFileCount} changed files</h3>
                  {result.summary.map((item) => <p key={item}>{item}</p>)}
                  {result.warnings.map((item) => <p className="agent-warning" key={item}>{item}</p>)}
                  {[...result.staged, ...result.unstaged, ...result.untracked].map((file, index) => (
                    <p className="agent-git-file" key={`${file.path}-${index}`}>
                      <code>{file.path}</code>
                      <span>{file.likelySecret ? "Likely secret — contents withheld" : file.status.trim() || "??"}</span>
                    </p>
                  ))}
                  {result.recentCommits.length > 0 && (
                    <div className="agent-recent-commits">
                      <strong>Recent commits</strong>
                      {result.recentCommits.map((commit, index) => (
                        <p key={`${index}-${commit}`}>{commit.replace(/\t/g, " · ")}</p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
