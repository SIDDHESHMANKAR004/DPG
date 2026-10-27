import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { createLocalAgent } from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function request(
  port: number,
  route: string,
  options: { method?: string; origin?: string; token?: string; body?: unknown; host?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${port}`,
    };
    if (options.origin) headers.Origin = options.origin;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const req = httpRequest(
      { host: "127.0.0.1", port, path: route, method: options.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text ? JSON.parse(text) as unknown : null,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("Local Agent API security and endpoints", () => {
  it("requires a session token and validates Host and Origin", async () => {
    const origin = "https://dashboard.example";
    const agent = createLocalAgent({
      port: 0,
      token: "a".repeat(64),
      allowedOrigins: [origin],
    });
    await agent.listen();
    const address = agent.server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    try {
      assert.equal(address.address, "127.0.0.1");

      const noToken = await request(port, "/health", { origin });
      assert.equal(noToken.status, 401);

      const untrustedOrigin = await request(port, "/health", {
        origin: "https://attacker.example",
        token: agent.token,
      });
      assert.equal(untrustedOrigin.status, 403);

      const invalidHost = await request(port, "/health", {
        origin,
        token: agent.token,
        host: "rebind.attacker.example",
      });
      assert.equal(invalidHost.status, 403);

      const preflight = await request(port, "/projects/scan", {
        method: "OPTIONS",
        origin,
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers["access-control-allow-private-network"], "true");

      const health = await request(port, "/health", { origin, token: agent.token });
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, {
        status: "ok",
        agent: "developer-work-assistant-local-agent",
      });
    } finally {
      await agent.close();
    }
  });

  it("registers and scans a selected project, then serves approved project APIs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "developer-agent-api-"));
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "agent-api-sample", scripts: {} }),
    );
    const origin = "http://localhost:5173";
    const agent = createLocalAgent({
      port: 0,
      token: "b".repeat(64),
      allowedOrigins: [origin],
    });
    await agent.listen();
    const address = agent.server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    try {
      const invalidPath = await request(port, "/projects/scan", {
        method: "POST",
        origin,
        token: agent.token,
        body: { directory: "relative/path" },
      });
      assert.equal(invalidPath.status, 400);

      const scan = await request(port, "/projects/scan", {
        method: "POST",
        origin,
        token: agent.token,
        body: { directory },
      });
      assert.equal(scan.status, 200);
      const project = (scan.body as { project: { id: string; project: { name: string } } }).project;
      assert.equal(project.project.name, "agent-api-sample");

      const unregistered = await request(port, "/projects/not-registered/git/changes", {
        origin,
        token: agent.token,
      });
      assert.equal(unregistered.status, 404);

      const errors = await request(port, `/projects/${project.id}/errors/collect`, {
        method: "POST",
        origin,
        token: agent.token,
      });
      assert.equal(errors.status, 200);

      const git = await request(port, `/projects/${project.id}/git/changes`, {
        origin,
        token: agent.token,
      });
      assert.equal(git.status, 200);
      assert.equal((git.body as { result: { status: string } }).result.status, "not-git");
    } finally {
      await agent.close();
    }
  });

  it("redacts likely secret paths from Git responses", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "developer-agent-git-"));
    temporaryDirectories.push(directory);
    const git = (...args: string[]) =>
      execFileAsync("git", ["-C", directory, ...args], {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    await git("init", "-q");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "Test User");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "secret-path-test" }));
    await writeFile(path.join(directory, ".env"), "LOCAL_AGENT_SECRET_CONTENT\n");
    await git("add", "package.json", ".env");

    const origin = "http://localhost:5173";
    const agent = createLocalAgent({
      port: 0,
      token: "c".repeat(64),
      allowedOrigins: [origin],
    });
    await agent.listen();
    const address = agent.server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    try {
      const scan = await request(port, "/projects/scan", {
        method: "POST",
        origin,
        token: agent.token,
        body: { directory },
      });
      assert.equal(scan.status, 200);
      const projectId = (scan.body as { project: { id: string } }).project.id;
      const gitChanges = await request(port, `/projects/${projectId}/git/changes`, {
        origin,
        token: agent.token,
      });
      const serialized = JSON.stringify(gitChanges.body);
      assert.equal(gitChanges.status, 200);
      assert.doesNotMatch(serialized, /LOCAL_AGENT_SECRET_CONTENT/);
      assert.doesNotMatch(serialized, /\.env/);
      assert.match(serialized, /\[redacted secret file\]/);
    } finally {
      await agent.close();
    }
  });
});
