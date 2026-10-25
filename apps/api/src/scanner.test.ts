import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { scanProject } from "./scanner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-assistant-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("scanProject", () => {
  it("detects project metadata without reading secret files or ignored output", async () => {
    const directory = await createProject();
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "sample-project",
        packageManager: "pnpm@9.0.0",
        scripts: { test: "vitest run" },
        devDependencies: { react: "^19.0.0" },
      }),
    );
    await writeFile(path.join(directory, "pnpm-lock.yaml"), "");
    await writeFile(path.join(directory, "tsconfig.json"), "{}");
    await writeFile(path.join(directory, "vite.config.ts"), "export default {}");
    await writeFile(path.join(directory, "main.tsx"), "");
    await writeFile(path.join(directory, ".env"), "SECRET_VALUE=never expose this");
    await mkdir(path.join(directory, ".git"));
    await mkdir(path.join(directory, "node_modules"));
    await writeFile(path.join(directory, "node_modules", "ignored.ts"), "");

    const project = await scanProject(directory);

    assert.equal(project.name, "sample-project");
    assert.deepEqual(project.technologies, ["Node.js", "Vite", "React", "TypeScript", "pnpm"]);
    assert.equal(project.packageManager, "pnpm");
    assert.deepEqual(project.scripts, { test: "vitest run" });
    assert.equal(project.gitRepository, true);
    assert.ok(!JSON.stringify(project).includes("SECRET_VALUE"));
    assert.ok(!JSON.stringify(project).includes("ignored.ts"));
  });

  it("handles a directory without a package manifest", async () => {
    const directory = await createProject();

    const project = await scanProject(directory);

    assert.equal(project.name, path.basename(directory));
    assert.deepEqual(project.technologies, []);
    assert.deepEqual(project.scripts, {});
    assert.ok(project.findings.includes("No root package.json found."));
  });

  it("rejects non-absolute paths", async () => {
    await assert.rejects(scanProject("relative/path"), /absolute project directory/);
  });
});
