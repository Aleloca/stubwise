import type { CiRun, Release } from "../../types";
import { daysFromToday } from "../dates";

// I rilasci dell'area 8a: un rilascio = un merge sul ramo di rilascio. Ce
// n'è uno per ogni `pr_merged` della cronologia (`timeline.ts`, stessi
// orari), più la #241 di AUD, che non ha una task. Lo stato NON si salva: lo
// derivano le run e l'ambiente di produzione (Task 4).
//
// - AUD-V1 (#214, AUD-12): riuscito, due run di GitHub Actions.
// - AUD-V2 (#231, AUD-8): riuscito, mergiato FUORI da Stubwise da un'identità
//   git non collegata a nessuno (`mergedById: null`): chi lo riguarda è
//   l'autore della task della PR (`task_author`, Task 3).
// - AUD-V3 (#241, senza task): fallito, mergiato da Laura; la run «Deploy to
//   production» si è fermata alle migrazioni, con un log di ~5000 righe.
// - STW-V1 (#402, STW-9): senza pipeline, l'agente di produzione riporta il
//   suo commit.
// - STW-V2 (#405, STW-1): senza pipeline, mergiato da Marco fuori da
//   Stubwise, non ancora in produzione.

const at = (days: number, hms: string) => `${daysFromToday(-days)}T${hms}Z`;

/** Gli sha dei merge (finti, 40 caratteri): gli ambienti li riportano. */
export const MERGE_SHAS = {
  audV1: "a1c2e3f4b5d6a7c8e9f0b1d2c3e4f5a6b7c8d9e0",
  audV2: "f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0",
  audV3: "b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5",
  stwV1: "c0ffee12ab34cd56ef78ab90cd12ef34ab56cd78",
  stwV2: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
} as const;

/** Quante righe ha il log della run fallita (shape: «Last 40 of 5,012 lines»). */
export const FAILED_LOG_LINES = 5012;

/**
 * Il log finto della run fallita: install, build, poi le migrazioni, che si
 * fermano sull'ultima. Deterministico, nessuna casualità.
 */
function failedDeployLog(): string {
  const lines: string[] = [
    "Run actions/checkout@v4",
    "Syncing repository: audin/audin-app",
    "Run pnpm install --frozen-lockfile",
  ];
  let n = 0;
  while (lines.length < FAILED_LOG_LINES - 12) {
    n++;
    lines.push(
      n % 50 === 0
        ? `[build] chunk ${n / 50}: 50 modules transformed`
        : `[migrate] 2026_${String(1000 + (n % 900)).padStart(4, "0")}_backfill_call_rows: batch ${n} of ${FAILED_LOG_LINES} rows copied (${(n * 37) % 1000} ms)`,
    );
  }
  lines.push(
    "[migrate] Running 2026_10_19_invoices_add_vat_number.sql",
    "[migrate] ALTER TABLE invoices ADD COLUMN vat_number text NOT NULL",
    'ERROR:  column "vat_number" of relation "invoices" contains null values',
    "CONTEXT:  SQL statement in migration 2026_10_19_invoices_add_vat_number.sql, line 3",
    "[migrate] Rolling back 2026_10_19_invoices_add_vat_number.sql",
    "[migrate] 1 migration failed, 0 applied",
    "Error: Process completed with exit code 1.",
    "Post job cleanup.",
    "Stopping the database container",
    "Removing the build cache",
    "Cleaning up orphan processes",
    "##[error]Run migrations failed",
  );
  return lines.join("\n");
}

const run = (
  id: string,
  name: string,
  status: CiRun["status"],
  days: number,
  start: string,
  end: string | null,
  failedStep: string | null = null,
  log: string | null = null,
): CiRun => ({
  id,
  name,
  status,
  url: `https://github.com/audin/audin-app/actions/runs/${id.replace(/\D/g, "")}`,
  failedStep,
  log,
  startedAt: at(days, start),
  endedAt: end ? at(days, end) : null,
});

export const RELEASES: Release[] = [
  {
    id: "rel8-aud-1",
    code: "AUD-V1",
    projectId: "prj-aud",
    repositoryId: "repo-aud",
    pr: { repo: "audin/audin-app", number: 214 },
    title: "Drop the legacy SMS module",
    mergeSha: MERGE_SHAS.audV1,
    mergedAt: at(15, "12:30:00"),
    mergedById: "p-laura",
    mergedGitName: "Laura Costa",
    viaStubwise: true,
    runs: [
      run("run-71001", "CI", "success", 15, "12:30:20", "12:36:05"),
      run("run-71002", "Deploy to production", "success", 15, "12:36:30", "12:41:12"),
    ],
    seenInProductionAt: at(15, "12:42:00"),
    fixTaskId: null,
  },
  {
    id: "rel8-aud-2",
    code: "AUD-V2",
    projectId: "prj-aud",
    repositoryId: "repo-aud",
    pr: { repo: "audin/audin-app", number: 231 },
    title: "Launch announcement banner for existing customers",
    mergeSha: MERGE_SHAS.audV2,
    mergedAt: at(3, "14:30:00"),
    mergedById: null,
    mergedGitName: "ops-laptop",
    viaStubwise: false,
    runs: [
      run("run-72001", "CI", "success", 3, "14:30:15", "14:36:50"),
      run("run-72002", "Deploy to production", "success", 3, "14:37:10", "14:41:30"),
    ],
    seenInProductionAt: at(3, "14:42:00"),
    fixTaskId: null,
  },
  {
    id: "rel8-aud-3",
    code: "AUD-V3",
    projectId: "prj-aud",
    repositoryId: "repo-aud",
    pr: { repo: "audin/audin-app", number: 241 },
    title: "Invoices with the VAT number",
    mergeSha: MERGE_SHAS.audV3,
    mergedAt: at(3, "16:10:00"),
    mergedById: "p-laura",
    mergedGitName: "Laura Costa",
    viaStubwise: true,
    runs: [
      run("run-73001", "CI", "success", 3, "16:10:15", "16:17:40"),
      run(
        "run-73002",
        "Deploy to production",
        "failed",
        3,
        "16:18:02",
        "16:22:14",
        "Run migrations",
        failedDeployLog(),
      ),
    ],
    seenInProductionAt: null,
    fixTaskId: null,
  },
  {
    id: "rel8-stw-1",
    code: "STW-V1",
    projectId: "prj-stw",
    repositoryId: "repo-stw",
    pr: { repo: "stubwise/stubwise", number: 402 },
    title: "Fix the focus ring in the notifications panel",
    mergeSha: MERGE_SHAS.stwV1,
    mergedAt: at(6, "11:30:00"),
    mergedById: "p-laura",
    mergedGitName: "Laura Costa",
    viaStubwise: true,
    runs: [],
    seenInProductionAt: at(6, "16:05:00"),
    fixTaskId: null,
  },
  {
    id: "rel8-stw-2",
    code: "STW-V2",
    projectId: "prj-stw",
    repositoryId: "repo-stw",
    pr: { repo: "stubwise/stubwise", number: 405 },
    title: "Fake data layer aware of the viewer",
    mergeSha: MERGE_SHAS.stwV2,
    mergedAt: at(2, "15:30:00"),
    mergedById: "p-marco",
    mergedGitName: "mbellini",
    viaStubwise: false,
    runs: [],
    seenInProductionAt: null,
    fixTaskId: null,
  },
];
