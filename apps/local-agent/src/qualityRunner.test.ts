import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runLocalQuality } from "./qualityRunner.js";
import type { ProjectScan } from "../../api/src/scanner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-agent-quality-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

function project(directory: string): ProjectScan {
  return {
    directory,
    name: "agent-quality-test",
    scannedAt: new Date().toISOString(),
    technologies: ["Node.js"],
    packageManager: "npm",
    scripts: { build: "node -e \"require('fs').writeFileSync('build-output.txt', 'done')\"" },
    gitRepository: false,
    findings: [],
    truncated: false,
  };
}

describe("Local Agent quality runner", () => {
  it("requires build confirmation and runs only the fixed build script when confirmed", async () => {
    const directory = await createProject();
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          prebuild: "node -e \"require('fs').writeFileSync('prebuild-output.txt', 'unexpected')\"",
          build: "node -e \"require('fs').writeFileSync('build-output.txt', 'done')\"",
          postbuild: "node -e \"require('fs').writeFileSync('postbuild-output.txt', 'unexpected')\"",
        },
      }),
    );

    const unconfirmed = await runLocalQuality(project(directory), {
      includeBuild: true,
      confirmBuild: false,
    });
    assert.equal(unconfirmed.build?.status, "unavailable");
    await assert.rejects(access(path.join(directory, "build-output.txt")));

    const confirmed = await runLocalQuality(project(directory), {
      includeBuild: true,
      confirmBuild: true,
    });
    assert.equal(confirmed.build?.status, "success");
    assert.equal(confirmed.build?.stdout, "");
    assert.equal(confirmed.build?.stderr, "");
    assert.equal(await readFile(path.join(directory, "build-output.txt"), "utf8"), "done");
    await assert.rejects(access(path.join(directory, "prebuild-output.txt")));
    await assert.rejects(access(path.join(directory, "postbuild-output.txt")));
  });
});
