import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGitChanges } from "../../api/src/gitChanges.js";
import type { ProjectScan } from "../../api/src/scanner.js";
import { collectErrors } from "./errorCollector.js";
import { runLocalQuality } from "./qualityRunner.js";
import { ProjectRegistry } from "./security.js";

const defaultPort = 4317;
const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];
const maxJsonBytes = "10kb";

export interface LocalAgentOptions {
  port?: number;
  token?: string;
  allowedOrigins?: string[];
}

export interface LocalAgentServer {
  server: Server;
  token: string;
  registry: ProjectRegistry;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function getAllowedOrigins(override?: string[]): Set<string> {
  const configured = override ??
    process.env.LOCAL_AGENT_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ??
    defaultOrigins;
  for (const origin of configured) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid Local Agent allowed origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Local Agent origins must be exact HTTP(S) origins: ${origin}`);
    }
  }
  return new Set(configured);
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function secureMiddleware(
  token: string,
  allowedOrigins: Set<string>,
  getPort: () => number,
): express.RequestHandler {
  return (request, response, next) => {
    const port = getPort();
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = request.get("host")?.toLowerCase();
    if (!host || !hosts.has(host)) {
      response.status(403).json({ error: "Invalid Local Agent host." });
      return;
    }

    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "Request origin is not allowed by the Local Agent." });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }

    if (request.method === "OPTIONS") {
      if (!origin) {
        response.status(403).end();
        return;
      }
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Max-Age", "300");
      response.status(204).end();
      return;
    }

    const authorization = request.get("authorization");
    const match = authorization?.match(/^Bearer ([A-Fa-f0-9]{64})$/);
    if (!match || !constantTimeTokenMatch(token, match[1])) {
      response.status(401).json({ error: "A valid Local Agent session token is required." });
      return;
    }
    next();
  };
}

function projectFromRequest(
  request: Request,
  registry: ProjectRegistry,
  response: Response,
): ProjectScan | undefined {
  const projectId = Array.isArray(request.params.id)
    ? request.params.id[0]
    : request.params.id;
  const registered = registry.get(projectId);
  if (!registered) {
    response.status(404).json({ error: "Project is not registered with this Local Agent session." });
    return undefined;
  }
  return registered.scan;
}

export function createLocalAgent(options: LocalAgentOptions = {}): LocalAgentServer {
  const port = options.port ?? Number(process.env.LOCAL_AGENT_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Local Agent port must be an integer between 0 and 65535.");
  }
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) {
    throw new Error("Local Agent token must be a 32-byte hexadecimal value.");
  }
  const allowedOrigins = getAllowedOrigins(options.allowedOrigins);
  const registry = new ProjectRegistry();
  const app = express();
  let actualPort = port;

  app.disable("x-powered-by");
  app.use(secureMiddleware(token, allowedOrigins, () => actualPort));
  app.use(express.json({ limit: maxJsonBytes, strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", agent: "developer-work-assistant-local-agent" });
  });

  app.get("/projects", (_request, response) => {
    response.json({
      projects: registry.list().map(({ id, scan }) => ({ id, project: scan })),
    });
  });

  app.post("/projects/scan", async (request, response) => {
    if (
      typeof request.body !== "object" ||
      request.body === null ||
      typeof request.body.directory !== "string"
    ) {
      response.status(400).json({ error: "An absolute project directory is required." });
      return;
    }
    try {
      const registered = await registry.register(request.body.directory);
      response.json({ project: { id: registered.id, project: registered.scan } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project scan failed.";
      response.status(400).json({ error: message });
    }
  });

  app.post("/projects/:id/errors/collect", async (request, response, next) => {
    const project = projectFromRequest(request, registry, response);
    if (!project) return;
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const result = await collectErrors(project, controller.signal);
      if (!response.destroyed) response.json({ result });
    } catch (error) {
      if (!response.destroyed) next(error);
    }
  });

  app.post("/projects/:id/quality/run", async (request, response, next) => {
    const project = projectFromRequest(request, registry, response);
    if (!project) return;
    if (
      request.body !== undefined &&
      (typeof request.body !== "object" ||
        request.body === null ||
        (request.body.includeBuild !== undefined && typeof request.body.includeBuild !== "boolean") ||
        (request.body.confirmBuild !== undefined && typeof request.body.confirmBuild !== "boolean"))
    ) {
      response.status(400).json({ error: "Invalid quality-run options." });
      return;
    }
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const result = await runLocalQuality(project, {
        includeBuild: request.body?.includeBuild === true,
        confirmBuild: request.body?.confirmBuild === true,
        signal: controller.signal,
      });
      response.json({
        result: {
          ...result,
          checks: {
            ...result.checks,
            checks: result.checks.checks.map((check) => ({
              ...check,
              stdout: "",
              stderr: "",
            })),
          },
        },
      });
    } catch (error) {
      if (!response.destroyed) next(error);
    }
  });

  app.get("/projects/:id/git/changes", async (request, response, next) => {
    const project = projectFromRequest(request, registry, response);
    if (!project) return;
    try {
      const result = await getGitChanges(project);
      for (const category of [result.staged, result.unstaged, result.untracked]) {
        for (const file of category) {
          if (file.likelySecret) {
            file.path = "[redacted secret file]";
            if (file.previousPath) file.previousPath = "[redacted secret file]";
          }
        }
      }
      response.json({ result });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Local Agent request failed:", error);
    if (response.headersSent) return;
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error.status === 400 || error.status === 413)
        ? error.status
        : 500;
    response.status(status).json({
      error: status === 413 ? "Request body is too large." : "Local Agent request failed.",
    });
  });

  const server = createServer(app);
  return {
    server,
    token,
    registry,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address !== "string") actualPort = address.port;
          server.removeListener("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() ===
    path.resolve(process.argv[1]).toLowerCase();

if (isEntrypoint) {
  const agent = createLocalAgent();
  await agent.listen();
  const address = agent.server.address();
  const port = address && typeof address !== "string" ? address.port : defaultPort;
  console.log(`Local Agent listening at http://127.0.0.1:${port}`);
  console.log(`Local Agent session token: ${agent.token}`);
  console.log("Copy the session token into the dashboard. Do not share it.");

  const stop = () => {
    void agent.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
