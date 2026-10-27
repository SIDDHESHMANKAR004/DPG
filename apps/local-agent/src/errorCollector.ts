import { runQualityChecks, type Diagnostic, type QualityResult } from "../../api/src/quality.js";
import type { ProjectScan } from "../../api/src/scanner.js";

export interface CollectedErrors {
  project: string;
  status: QualityResult["status"];
  diagnostics: (Diagnostic & { tool: string })[];
  completedAt: string;
}

export async function collectErrors(
  project: ProjectScan,
  signal?: AbortSignal,
): Promise<CollectedErrors> {
  const quality = await runQualityChecks(project, signal);
  return {
    project: project.directory,
    status: quality.status,
    diagnostics: quality.checks.flatMap((check) =>
      check.diagnostics.map((diagnostic) => ({ ...diagnostic, tool: check.tool })),
    ),
    completedAt: quality.completedAt,
  };
}
