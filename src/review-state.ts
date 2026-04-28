import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ReviewedFiles = Record<string, string>;

interface ReviewedFilesState {
  version: 1;
  files: ReviewedFiles;
}

async function getReviewedFilesPath(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--git-path", "pi-diff-review-reviewed.json"], { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to resolve git metadata path.");
  }
  const statePath = result.stdout.trim();
  return isAbsolute(statePath) ? statePath : join(repoRoot, statePath);
}

function isReviewedFiles(value: unknown): value is ReviewedFiles {
  return value != null
    && typeof value === "object"
    && Object.values(value).every((item) => typeof item === "string");
}

export async function loadReviewedFiles(pi: ExtensionAPI, repoRoot: string): Promise<ReviewedFiles> {
  try {
    const statePath = await getReviewedFilesPath(pi, repoRoot);
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<ReviewedFilesState>;
    return isReviewedFiles(parsed.files) ? parsed.files : {};
  } catch {
    return {};
  }
}

export async function saveReviewedFiles(pi: ExtensionAPI, repoRoot: string, files: ReviewedFiles): Promise<void> {
  const statePath = await getReviewedFilesPath(pi, repoRoot);
  await mkdir(dirname(statePath), { recursive: true });
  const state: ReviewedFilesState = {
    version: 1,
    files,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
