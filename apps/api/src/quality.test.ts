import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ProjectScan } from "./scanner.js";
import {
  parseEslintDiagnostics,
  parseTypeScriptDiagnostics,
  runQualityChecks,
} from "./quality.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-quality-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

function projectMetadata(directory: string, scripts: Record<string, string> = {}): ProjectScan {
  return {
    directory,
    name: "quality-test",
    scannedAt: new Date().toISOString(),
    technologies: [],
    packageManager: null,
    scripts,
    gitRepository: false,
    findings: [],
    truncated: false,
  };
}

describe("quality diagnostics", () => {
  it("groups repeated ESLint diagnostics and normalizes locations", () => {
    const filePath = path.join("C:\\project", "src", "main.ts");
    const output = JSON.stringify([{
      filePath,
      messages: [
        { ruleId: "no-unused-vars", severity: 2, message: "Unused value.", line: 4, column: 2 },
        { ruleId: "no-unused-vars", severity: 2, message: "Unused value.", line: 4, column: 2 },
      ],
    }]);
    const diagnostics = parseEslintDiagnostics(output, "C:\\project");

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "error");
    assert.equal(diagnostics[0].file, "src/main.ts");
    assert.equal(diagnostics[0].occurrences, 2);
  });

  it("parses TypeScript errors and warnings", () => {
    const diagnostics = parseTypeScriptDiagnostics(
      "src/index.ts(2,3): error TS2322: Type mismatch.\n" +
      "src/index.ts(8,1): warning TS6133: Unused value.",
    );

    assert.deepEqual(
      diagnostics.map(({ severity, file, line, column }) => ({ severity, file, line, column })),
      [
        { severity: "error", file: "src/index.ts", line: 2, column: 3 },
        { severity: "warning", file: "src/index.ts", line: 8, column: 1 },
      ],
    );
  });
});

describe("runQualityChecks", () => {
  it("runs local binaries with fixed arguments and does not execute package scripts", async () => {
    const directory = await createProject();
    const eslintBin = path.join(directory, "node_modules", "eslint", "bin");
    const typescriptBin = path.join(directory, "node_modules", "typescript", "bin");
    await mkdir(eslintBin, { recursive: true });
    await mkdir(typescriptBin, { recursive: true });
    await writeFile(path.join(directory, "eslint.config.js"), "export default [];");
    await writeFile(path.join(directory, "tsconfig.json"), "{}");
    await writeFile(
      path.join(eslintBin, "eslint.js"),
      `process.stdout.write(JSON.stringify([{filePath:${JSON.stringify(path.join(directory, "src.ts"))},messages:[{ruleId:"test",severity:1,message:"Review this.",line:3,column:1}]}]));`,
    );
    await writeFile(
      path.join(typescriptBin, "tsc"),
      'if (!process.argv.includes("--noEmit") || !process.argv.includes("--project")) process.exit(3); process.stdout.write("src.ts(5,2): error TS2322: Type mismatch.\\n"); process.exitCode = 2;',
    );
    const marker = path.join(directory, "script-was-run");
    const result = await runQualityChecks(projectMetadata(directory, {
      lint: `node -e "require('fs').writeFileSync('${marker}', '')"`,
      typecheck: "user provided command must not run",
    }));

    assert.equal(result.status, "failure");
    assert.equal(result.checks[0].status, "success");
    assert.equal(result.checks[0].diagnostics[0].severity, "warning");
    assert.equal(result.checks[1].status, "failure");
    assert.equal(result.checks[1].diagnostics[0].message, "Type mismatch.");
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(marker)));
  });

  it("reports missing scripts while still running configured checks", async () => {
    const directory = await createProject();
    await mkdir(path.join(directory, "node_modules", "eslint", "bin"), { recursive: true });
    await writeFile(path.join(directory, "eslint.config.js"), "export default [];");
    await writeFile(
      path.join(directory, "node_modules", "eslint", "bin", "eslint.js"),
      'process.stdout.write("[]");',
    );

    const result = await runQualityChecks(projectMetadata(directory));

    assert.equal(result.checks[0].status, "success");
    assert.match(result.checks[0].note ?? "", /No lint script is defined/);
    assert.equal(result.checks[1].status, "skipped");
  });

  it("reports configured tools as unavailable when they are not installed locally", async () => {
    const directory = await createProject();
    await writeFile(path.join(directory, "eslint.config.js"), "export default [];");

    const result = await runQualityChecks(projectMetadata(directory));

    assert.equal(result.status, "unavailable");
    assert.equal(result.checks[0].status, "unavailable");
    assert.match(result.checks[0].note ?? "", /not installed locally/);
  });

  it("cancels an active check", async () => {
    const directory = await createProject();
    await mkdir(path.join(directory, "node_modules", "eslint", "bin"), { recursive: true });
    await writeFile(path.join(directory, "eslint.config.js"), "export default [];");
    await writeFile(
      path.join(directory, "node_modules", "eslint", "bin", "eslint.js"),
      "setInterval(() => {}, 1000);",
    );
    const controller = new AbortController();
    const abortTimeout = setTimeout(() => controller.abort(), 50);

    const result = await runQualityChecks(projectMetadata(directory), controller.signal);
    clearTimeout(abortTimeout);

    assert.equal(result.status, "cancelled");
    assert.equal(result.checks[0].status, "cancelled");
  });
});
