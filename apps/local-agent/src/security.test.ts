import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectRegistry, validateProjectPath } from "./security.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-agent-project-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "approved-local-project", scripts: { test: "node test.js" } }),
  );
  return directory;
}

describe("Local Agent path security", () => {
  it("accepts absolute local directories and rejects relative paths", async () => {
    const directory = await createProject();

    assert.equal(await validateProjectPath(directory), await realpath(directory));
    await assert.rejects(validateProjectPath("relative/project"), /absolute local path/);
    await assert.rejects(validateProjectPath(path.join(directory, "missing")), /ENOENT/);
  });

  it("rejects Windows UNC paths", async () => {
    if (process.platform !== "win32") return;
    await assert.rejects(validateProjectPath("\\\\server\\share\\project"), /UNC paths/);
  });

  it("registers only explicitly submitted projects and reuses their session id", async () => {
    const directory = await createProject();
    const registry = new ProjectRegistry();

    const first = await registry.register(directory);
    const second = await registry.register(directory);

    assert.equal(first.id, second.id);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get(first.id)?.scan.name, "approved-local-project");
  });
});
