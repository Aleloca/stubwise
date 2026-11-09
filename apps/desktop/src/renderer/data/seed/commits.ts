import type { CommitOfDay } from "../types";
import { daysFromToday } from "./dates";
import { PEOPLE } from "./people";

// I commit di oggi e di ieri sui repository di STW e AUD, per la rassegna
// per persona. `aiSummary` è il riassunto generato del commit (come
// `commit_summaries` del giro notturno): la UI lo etichetta «Testo generato».
// Un autore non è collegato a nessuna persona: la rassegna offre
// «Collega una persona».

const REPOS: Record<string, string> = { STW: "stubwise", AUD: "audin-app" };

// [codice progetto, autore (id persona, o nome git se non collegato), giorni fa, ora, messaggio, riassunto]
type Row = [string, string, number, string, string, string];

// prettier-ignore
const ROWS: Row[] = [
  ["STW", "p-simone", 0, "08:42", "feat(board): move cards between columns with the keyboard", "Cards on the board can now be moved to the next or previous column with the arrow keys while holding Alt."],
  ["STW", "p-simone", 0, "11:05", "fix(board): announce the drop target to screen readers", "The board tells screen readers which column a card is about to land in."],
  ["STW", "p-marco", 0, "09:18", "test(layout): reproduce the crash at the minimum window size", "Adds a test that resizes the window to 1024 × 680 and checks the layout does not throw."],
  ["STW", "p-federico", 0, "10:31", "feat(filters): share a saved filter with the team", "A saved filter can be made public; the owner keeps the right to change it."],
  ["AUD", "p-stefano", 0, "09:02", "feat(export): call history columns and spreadsheet download", "The call history export gets its columns and a download button that prepares the file."],
  ["AUD", "p-alessia", 0, "14:47", "perf(dashboard): cache the totals of large accounts", "Totals on the dashboard of large accounts are cached for five minutes, which cuts the load time."],
  ["AUD", "kevin.ortega", 0, "16:20", "chore(deps): bump the telephony SDK to 4.2", "Updates the telephony SDK to version 4.2; no code changes were needed."],
  ["STW", "p-marco", 1, "15:12", "refactor(data): carry the person in every query key", "Every query of the fake data layer now includes who is looking, so switching person never reuses stale results."],
  ["STW", "p-laura", 1, "09:40", "docs(planning): describe how a slipped task moves", "The planning guide explains what happens to a task that ends the week still open."],
  ["STW", "p-simone", 1, "17:55", "feat(board): drop announcement", "First version of the spoken announcement when a card is dropped."],
  ["AUD", "p-stefano", 1, "10:14", "feat(export): background export for long periods", "Exports longer than a month are prepared in the background and sent by email."],
  ["AUD", "p-marco", 1, "12:03", "fix(import): show duplicate rows in the preview", "The CSV import preview marks the rows that match an existing contact."],
  ["AUD", "p-alessia", 1, "16:38", "chore(dashboard): profile the large account queries", "Adds timing logs around the dashboard queries of large accounts."],
  ["AUD", "kevin.ortega", 1, "18:02", "ci: retry the flaky dialer test once", "The dialer test in CI is retried once before failing the build."],
];

/** Un hash esadecimale di 40 cifre, deterministico (FNV-1a ripetuto): finto ma stabile. */
export function fakeSha(seed: string): string {
  let out = "";
  for (let salt = 0; out.length < 40; salt++) {
    let h = 0x811c9dc5 ^ salt;
    for (const ch of `${salt}:${seed}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

export const COMMITS: CommitOfDay[] = ROWS.map(([code, author, days, time, message, aiSummary]) => {
  const person = PEOPLE.find((p) => p.id === author);
  const at = `${daysFromToday(-days)}T${time}:00Z`;
  return {
    sha: fakeSha(`${code}|${at}|${message}`),
    repo: REPOS[code]!,
    authorId: person?.id ?? null,
    authorName: person?.name ?? author,
    message,
    aiSummary,
    at,
    projectId: `prj-${code.toLowerCase()}`,
  };
});
