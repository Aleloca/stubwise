// Alcuni file dei repository collegati (STW, AUD): quanto basta perché il
// menu «#» della casella li trovi e Claude li citi. Un file si cita come
// `<repo>:<percorso>`; lo vede solo chi ha `repos.view` nel progetto.

export interface RepoFile {
  /** `<repo>:<percorso>`, l'id della citazione. */
  id: string;
  repo: string;
  path: string;
  projectId: string;
}

const REPOS: Record<string, string> = { "prj-stw": "stubwise", "prj-aud": "audin-app" };

// [progetto, percorso]
// prettier-ignore
const ROWS: [string, string][] = [
  ["prj-aud", "src/import/match.ts"],
  ["prj-aud", "src/import/preview.tsx"],
  ["prj-aud", "src/callbacks/reminder.ts"],
  ["prj-aud", "src/calls/export-job.ts"],
  ["prj-aud", "src/billing/invoice-email.ts"],
  ["prj-stw", "apps/web/src/pages/board/BoardColumn.tsx"],
  ["prj-stw", "apps/web/src/pages/board/useBoardKeys.ts"],
  ["prj-stw", "apps/server/src/services/stalled.ts"],
  ["prj-stw", "apps/worker/src/pipeline/repo-steps.ts"],
  ["prj-stw", "packages/notifications/src/project-signals.ts"],
];

export const REPO_FILES: RepoFile[] = ROWS.map(([projectId, path]) => {
  const repo = REPOS[projectId]!;
  return { id: `${repo}:${path}`, repo, path, projectId };
});

/** Il progetto di un repository, per una citazione `<repo>:<percorso>`. */
export function projectOfRepo(repo: string): string | null {
  return Object.entries(REPOS).find(([, name]) => name === repo)?.[0] ?? null;
}
