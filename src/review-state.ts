import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const reviewStatePath = join(homedir(), '.pi', 'agent', 'state', 'pi-diff-review', 'reviewed-files.json')

interface PersistedReviewState {
  version: 1;
  repositories?: Record<string, string[]>;
}

function createEmptyState(): PersistedReviewState {
  return {
    version: 1,
    repositories: {},
  }
}

async function readReviewState(): Promise<PersistedReviewState> {
  try {
    const content = await readFile(reviewStatePath, 'utf8')
    const parsed = JSON.parse(content) as PersistedReviewState
    if (parsed == null || typeof parsed !== 'object') return createEmptyState()
    return {
      version: 1,
      repositories: parsed.repositories ?? {},
    }
  } catch {
    return createEmptyState()
  }
}

async function writeReviewState(state: PersistedReviewState): Promise<void> {
  await mkdir(dirname(reviewStatePath), { recursive: true })
  const tmpPath = `${reviewStatePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, JSON.stringify(state, null, 2))
  await rename(tmpPath, reviewStatePath)
}

export async function loadReviewedFingerprints(repoRoot: string): Promise<Set<string>> {
  const state = await readReviewState()
  return new Set(state.repositories?.[repoRoot] ?? [])
}

export async function updateReviewedFingerprint(repoRoot: string, fingerprint: string, reviewed: boolean): Promise<void> {
  if (fingerprint.length === 0) return

  const state = await readReviewState()
  const fingerprints = new Set(state.repositories?.[repoRoot] ?? [])

  if (reviewed) fingerprints.add(fingerprint)
  else fingerprints.delete(fingerprint)

  state.repositories ??= {}

  if (fingerprints.size === 0) delete state.repositories[repoRoot]
  else state.repositories[repoRoot] = [...fingerprints].sort()

  await writeReviewState(state)
}
