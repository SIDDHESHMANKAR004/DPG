import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

export interface AgentProjectScan {
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

export interface RegisteredAgentProject {
  id: string;
  project: AgentProjectScan;
}

export interface AgentDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  occurrences: number;
  tool?: string;
}

export interface AgentCheck {
  tool: "ESLint" | "TypeScript";
  status: string;
  exitCode: number | null;
  diagnostics: AgentDiagnostic[];
  note?: string;
}

export interface AgentBuild {
  status: string;
  exitCode: number | null;
  note?: string;
}

export interface AgentQuality {
  checks: { status: string; checks: AgentCheck[] };
  build: AgentBuild | null;
}

export interface AgentGitChanges {
  status: string;
  branch: string | null;
  staged: { path: string; status: string; likelySecret: boolean }[];
  unstaged: { path: string; status: string; likelySecret: boolean }[];
  untracked: { path: string; status: string; likelySecret: boolean }[];
  totalFileCount: number;
  recentCommits: string[];
  summary: string[];
  warnings: string[];
  message?: string;
}

interface AgentConfig {
  url: string;
  token: string;
}

interface LocalAgentContextValue {
  status: "connected" | "disconnected";
  config: AgentConfig;
  projects: RegisteredAgentProject[];
  error: string;
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  registerProject(directory: string): Promise<RegisteredAgentProject>;
  collectErrors(id: string): Promise<{ diagnostics: AgentDiagnostic[]; status: string }>;
  runQuality(id: string, includeBuild?: boolean, confirmBuild?: boolean): Promise<AgentQuality>;
  getGitChanges(id: string): Promise<AgentGitChanges>;
}

const storageKey = "developer-work-assistant-local-agent";
const defaultUrl = "http://127.0.0.1:4317";
const LocalAgentContext = createContext<LocalAgentContextValue | null>(null);

function readConfig(): AgentConfig {
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) {
      const value: unknown = JSON.parse(stored);
      if (
        typeof value === "object" &&
        value !== null &&
        "url" in value &&
        typeof value.url === "string" &&
        "token" in value &&
        typeof value.token === "string"
      ) {
        return { url: value.url, token: value.token };
      }
    }
  } catch {
    sessionStorage.removeItem(storageKey);
  }
  return { url: defaultUrl, token: "" };
}

function validateAgentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Local Agent URL.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The Local Agent URL must use http://localhost or http://127.0.0.1.");
  }
  return url.origin;
}

async function requestAgent<T>(
  config: AgentConfig,
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${config.url}${route}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Local Agent returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function LocalAgentProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AgentConfig>(readConfig);
  const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
  const [projects, setProjects] = useState<RegisteredAgentProject[]>([]);
  const [error, setError] = useState("");

  const request = useCallback(
    async <T,>(
      route: string,
      options: { method?: string; body?: unknown } = {},
    ): Promise<T> => {
      try {
        const result = await requestAgent<T>(config, route, options);
        setError("");
        return result;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "Local Agent request failed.";
        if (/HTTP 401|valid Local Agent session token/i.test(message)) {
          sessionStorage.removeItem(storageKey);
          setConfig((current) => ({ ...current, token: "" }));
        }
        if (
          reason instanceof TypeError ||
          /session token|origin is not allowed|invalid local agent host/i.test(message)
        ) {
          setStatus("disconnected");
          setProjects([]);
        }
        setError(message);
        throw reason;
      }
    },
    [config],
  );

  const connect = useCallback(async (url: string, token: string) => {
    setError("");
    setStatus("disconnected");
    try {
      const normalizedConfig = { url: validateAgentUrl(url), token: token.trim() };
      if (!/^[A-Fa-f0-9]{64}$/.test(normalizedConfig.token)) {
        throw new Error("Enter the 64-character session token shown by the Local Agent.");
      }
      const health = await requestAgent<{ status: string }>(normalizedConfig, "/health");
      if (health.status !== "ok") throw new Error("The Local Agent health response was invalid.");
      const saved = await requestAgent<{ projects: RegisteredAgentProject[] }>(
        normalizedConfig,
        "/projects",
      );
      setConfig(normalizedConfig);
      sessionStorage.setItem(storageKey, JSON.stringify(normalizedConfig));
      setProjects(saved.projects);
      setStatus("connected");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `${reason.message} Confirm the agent is running, its origin is allowed, and the token is current.`
          : "Could not connect to the Local Agent.",
      );
      setProjects([]);
      setStatus("disconnected");
    }
  }, []);

  const disconnect = useCallback(() => {
    setStatus("disconnected");
    setProjects([]);
    setError("");
    setConfig({ url: config.url, token: "" });
    sessionStorage.removeItem(storageKey);
  }, [config.url]);

  const registerProject = useCallback(async (directory: string) => {
    const response = await request<{ project: RegisteredAgentProject }>(
      "/projects/scan",
      { method: "POST", body: { directory } },
    );
    setProjects((current) => [
      response.project,
      ...current.filter((project) => project.id !== response.project.id),
    ]);
    return response.project;
  }, [request]);

  const collectErrors = useCallback(
    (id: string) =>
      request<{ result: { diagnostics: AgentDiagnostic[]; status: string } }>(
        `/projects/${encodeURIComponent(id)}/errors/collect`,
        { method: "POST", body: {} },
      ).then(({ result }) => result),
    [request],
  );

  const runQuality = useCallback(
    (id: string, includeBuild = false, confirmBuild = false) =>
      request<{ result: AgentQuality }>(
        `/projects/${encodeURIComponent(id)}/quality/run`,
        { method: "POST", body: { includeBuild, confirmBuild } },
      ).then(({ result }) => result),
    [request],
  );

  const getGitChanges = useCallback(
    (id: string) =>
      request<{ result: AgentGitChanges }>(
        `/projects/${encodeURIComponent(id)}/git/changes`,
      ).then(({ result }) => result),
    [request],
  );

  const value = useMemo(
    () => ({
      status,
      config,
      projects,
      error,
      connect,
      disconnect,
      registerProject,
      collectErrors,
      runQuality,
      getGitChanges,
    }),
    [status, config, projects, error, connect, disconnect, registerProject, collectErrors, runQuality, getGitChanges],
  );
  return <LocalAgentContext.Provider value={value}>{children}</LocalAgentContext.Provider>;
}

export function useLocalAgent(): LocalAgentContextValue {
  const context = useContext(LocalAgentContext);
  if (!context) throw new Error("useLocalAgent must be used within LocalAgentProvider.");
  return context;
}

export function LocalAgentConnectionPanel() {
  const { config, status, error, connect, disconnect } = useLocalAgent();
  const [url, setUrl] = useState(config.url);
  const [token, setToken] = useState(config.token);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await connect(url, token);
  }

  return (
    <section className="connection-card local-agent-card">
      <div className={`connection-icon ${status === "connected" ? "" : "disconnected"}`}>AG</div>
      <div className="connection-copy">
        <h2>Local Agent</h2>
        <p>
          {status === "connected"
            ? "Connected to the agent running on this computer."
            : "Disconnected. Start the Local Agent on this computer to analyze local projects."}
        </p>
        <form className="agent-connect-form" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="agent-url">Local Agent URL</label>
          <input
            id="agent-url"
            className="form-control"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="Local Agent URL"
            autoComplete="url"
          />
          <label className="visually-hidden" htmlFor="agent-token">Local Agent session token</label>
          <input
            id="agent-token"
            className="form-control"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Enter token shown in the agent terminal"
            aria-label="Local Agent session token"
            autoComplete="off"
          />
          {status === "connected" ? (
            <button className="btn btn-outline-secondary" type="button" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button className="btn btn-success" type="submit">
              Connect
            </button>
          )}
        </form>
        <p className="agent-help">Start with <code>npm run dev:agent</code>, then type <code>show-token</code> in its terminal. The token stays in this browser session.</p>
        {error && <div className="agent-connect-error" role="alert">{error}</div>}
      </div>
      <span className={`status-pill ${status === "connected" ? "online" : "unavailable"}`}>
        <span className="status-dot" />
        {status === "connected" ? "Connected" : "Disconnected"}
      </span>
    </section>
  );
}
