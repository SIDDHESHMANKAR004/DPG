import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function request(
  port: number,
  route: string,
  options: { origin?: string; host?: string; method?: string; connectHost?: string } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.connectHost ?? "127.0.0.1",
        port,
        path: route,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? `127.0.0.1:${port}`,
          ...(options.origin ? { Origin: options.origin } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) as unknown : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("API local-only security boundary", () => {
  it("serves local dashboard requests and rejects untrusted origins and hosts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "developer-api-security-"));
    temporaryDirectories.push(directory);
    const port = await unusedLoopbackPort();
    const workspaceRoot = path.resolve(process.cwd(), "..", "..");
    const tsxCli = path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const entrypoint = path.join(process.cwd(), "src", "index.ts");
    const child = spawn(process.execPath, [tsxCli, entrypoint], {
      cwd: directory,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
      windowsHide: true,
    });

    try {
      let health: Awaited<ReturnType<typeof request>> | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("Local API exited before its health route became available.");
        try {
          health = await request(port, "/api/health");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(health?.status, 200);

      const projects = await request(port, "/api/projects", {
        origin: "http://localhost:5173",
        host: "localhost:5173",
      });
      assert.equal(projects.status, 200);

      const disallowedOrigin = await request(port, "/api/projects", {
        origin: "https://untrusted.example",
      });
      assert.equal(disallowedOrigin.status, 403);

      const invalidHost = await request(port, "/api/health", {
        host: "rebind.untrusted.example",
      });
      assert.equal(invalidHost.status, 403);

      const preflight = await request(port, "/api/projects", {
        method: "OPTIONS",
        origin: "http://localhost:5173",
      });
      assert.equal(preflight.status, 204);

      const externalInterface = Object.values(os.networkInterfaces())
        .flatMap((interfaces) => interfaces ?? [])
        .find((address) => address.family === "IPv4" && !address.internal)?.address;
      if (externalInterface) {
        const externalConnection = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: externalInterface, port });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
          socket.setTimeout(500, () => {
            socket.destroy();
            resolve(false);
          });
        });
        assert.equal(externalConnection, false);
      }
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
    }
  });
});
