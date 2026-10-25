import express from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ScanInputError, scanProject, type ProjectScan } from "./scanner.js";
import { runQualityChecks } from "./quality.js";
import { getGitChanges } from "./gitChanges.js";
import {
  buildDailyReport,
  gitActivity,
  projectScanActivity,
  qualityActivity,
  readActivities,
  readDailyReport,
  recordActivity,
  saveDailyReport,
  validateReportDate,
} from "./reports.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const dataDirectory = path.join(process.cwd(), "data");
const projectsFile = path.join(dataDirectory, "projects.json");

function requestLocalDate(value: unknown): string | undefined {
  if (typeof value === "string") return validateReportDate(value) ? value : undefined;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/projects", async (_request, response) => {
  try {
    const contents = await readFile(projectsFile, "utf8");
    response.json({ projects: JSON.parse(contents) as ProjectScan[] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.json({ projects: [] });
      return;
    }
    throw error;
  }
});

app.post("/api/projects/scan", async (request, response) => {
  if (
    typeof request.body !== "object" ||
    request.body === null ||
    typeof request.body.directory !== "string"
  ) {
    response.status(400).json({ error: "An absolute project directory is required." });
    return;
  }
  const localDate = requestLocalDate(request.body.localDate);
  if (!localDate) {
    response.status(400).json({ error: "Local date must use YYYY-MM-DD format." });
    return;
  }

  try {
    const scan = await scanProject(request.body.directory);
    const projects = await readSavedProjects();
    const updatedProjects = [
      scan,
      ...projects.filter((project) => project.directory !== scan.directory),
    ];
    await saveProjects(updatedProjects);
    await recordActivity(dataDirectory, projectScanActivity(scan, localDate));
    response.json({ project: scan });
  } catch (error) {
    if (error instanceof ScanInputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

app.post("/api/projects/quality", async (request, response) => {
  if (
    typeof request.body !== "object" ||
    request.body === null ||
    typeof request.body.directory !== "string"
  ) {
    response.status(400).json({ error: "A saved project directory is required." });
    return;
  }
  const localDate = requestLocalDate(request.body.localDate);
  if (!localDate) {
    response.status(400).json({ error: "Local date must use YYYY-MM-DD format." });
    return;
  }

  const projects = await readSavedProjects();
  const project = projects.find(
    (savedProject) => savedProject.directory === request.body.directory,
  );
  if (!project) {
    response.status(404).json({ error: "Scan and save this project before running checks." });
    return;
  }

  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const result = await runQualityChecks(project, controller.signal);
    await recordActivity(dataDirectory, qualityActivity(project.name, result, localDate));
    if (!response.destroyed) response.json({ result });
  } catch (error) {
    if (!response.destroyed) throw error;
  }
});

app.post("/api/projects/git", async (request, response) => {
  if (
    typeof request.body !== "object" ||
    request.body === null ||
    typeof request.body.directory !== "string"
  ) {
    response.status(400).json({ error: "A saved project directory is required." });
    return;
  }
  const localDate = requestLocalDate(request.body.localDate);
  if (!localDate) {
    response.status(400).json({ error: "Local date must use YYYY-MM-DD format." });
    return;
  }

  const projects = await readSavedProjects();
  const project = projects.find(
    (savedProject) => savedProject.directory === request.body.directory,
  );
  if (!project) {
    response.status(404).json({ error: "Scan and save this project before viewing Git changes." });
    return;
  }

  const result = await getGitChanges(project);
  await recordActivity(dataDirectory, gitActivity(project.name, result, localDate));
  response.json({ result });
});

app.get("/api/reports/:date", async (request, response) => {
  if (!validateReportDate(request.params.date)) {
    response.status(400).json({ error: "Report date must be a valid YYYY-MM-DD date." });
    return;
  }
  response.json({ report: await readDailyReport(dataDirectory, request.params.date) });
});

app.post("/api/reports/generate", async (request, response) => {
  const date = requestLocalDate(request.body?.date);
  if (!date) {
    response.status(400).json({ error: "Report date must be a valid YYYY-MM-DD date." });
    return;
  }
  const report = buildDailyReport(date, await readActivities(dataDirectory));
  await saveDailyReport(dataDirectory, report);
  response.json({ report });
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("API request failed:", error);
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error.status === 400 || error.status === 413)
        ? error.status
        : 500;
    response
      .status(status)
      .json({ error: status === 413 ? "Request body is too large." : "The request could not be completed." });
  },
);

async function readSavedProjects(): Promise<ProjectScan[]> {
  try {
    return JSON.parse(await readFile(projectsFile, "utf8")) as ProjectScan[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveProjects(projects: ProjectScan[]): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${projectsFile}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(projects, null, 2), "utf8");
  await rename(temporaryFile, projectsFile);
}

app.listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://localhost:${port}`);
});
