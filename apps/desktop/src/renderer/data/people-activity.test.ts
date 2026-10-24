import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateDailyReport,
  linkCommitAuthor,
  listDailyReports,
  listPeopleActivity,
  resetApi,
  setLatency,
} from "./api";
import { TODAY } from "./seed/dates";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import { grantInstancePermission, resetViewerGrants } from "./viewer";

const as = (personId: string) => setSessionPersonId(personId);
const TZ = process.env.TZ;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  process.env.TZ = TZ;
});

describe("rassegna per persona — report giornalieri", () => {
  it("i report del giorno, solo dei progetti che chi guarda vede", async () => {
    as("p-roberta");
    const all = await listDailyReports(TODAY);
    expect(all.map((r) => r.projectId)).toEqual(["prj-stw"]);
    expect((await listDailyReports("2026-10-22")).map((r) => r.projectId).sort()).toEqual([
      "prj-aud",
      "prj-stw",
    ]);
    grantInstancePermission("p-sara", "people.activity.view");
    as("p-sara"); // non vede AUD
    expect((await listDailyReports("2026-10-22")).map((r) => r.projectId)).toEqual(["prj-stw"]);
  });

  it("senza people.activity.view è forbidden", async () => {
    as("p-sara");
    await expect(listDailyReports(TODAY)).rejects.toThrow("forbidden");
  });

  it("generarlo chiede settings.manage, come sul web; ne scrive uno pronto", async () => {
    as("p-giulia"); // vede la rassegna, ma non gestisce le impostazioni
    await expect(generateDailyReport("prj-aud", TODAY)).rejects.toThrow("forbidden");
    expect(state.dailyReports.some((r) => r.projectId === "prj-aud" && r.date === TODAY)).toBe(
      false,
    );
    as("p-roberta");
    const report = await generateDailyReport("prj-aud", TODAY);
    expect(report).toMatchObject({ projectId: "prj-aud", date: TODAY });
    expect(report.summary).toBeTruthy();
    expect((await listDailyReports(TODAY)).map((r) => r.projectId).sort()).toEqual([
      "prj-aud",
      "prj-stw",
    ]);
  });

  it("rigenerare un report fallito lo sostituisce, niente futuro", async () => {
    as("p-roberta");
    const failed = state.dailyReports.find((r) => r.projectId === "prj-aud" && r.summary === null)!;
    await generateDailyReport("prj-aud", failed.date);
    const same = state.dailyReports.filter(
      (r) => r.projectId === "prj-aud" && r.date === failed.date,
    );
    expect(same).toHaveLength(1);
    expect(same[0]!.summary).toBeTruthy();
    await expect(generateDailyReport("prj-aud", "2026-10-30")).rejects.toThrow("invalid");
  });
});

describe("rassegna per persona — autori non collegati", () => {
  it("collegarlo chiede users.manage; poi i commit passano sotto la persona", async () => {
    as("p-giulia");
    await expect(linkCommitAuthor("kevin.ortega", "p-stefano")).rejects.toThrow("forbidden");
    as("p-roberta");
    await linkCommitAuthor("kevin.ortega", "p-stefano");
    const rows = await listPeopleActivity(TODAY);
    expect(rows.some((p) => p.personId === null)).toBe(false);
    const stefano = rows.find((p) => p.personId === "p-stefano")!;
    expect(stefano.commits.map((c) => c.authorName)).toContain("kevin.ortega");
  });

  it("un autore che non esiste o una persona sconosciuta sono rifiutati", async () => {
    as("p-roberta");
    await expect(linkCommitAuthor("nobody", "p-stefano")).rejects.toThrow("not_found");
    await expect(linkCommitAuthor("kevin.ortega", "p-nobody")).rejects.toThrow("not_found");
    await expect(linkCommitAuthor("kevin.ortega", "p-claude")).rejects.toThrow("not_found");
  });
});

describe("rassegna per persona — confini del giorno", () => {
  it("il giorno è quello locale di chi guarda", async () => {
    process.env.TZ = "Europe/Rome";
    state.activity.push({
      id: "a-late",
      taskId: "t-stw-13",
      kind: "comment",
      authorId: "p-laura",
      at: "2026-10-22T23:30:00Z", // 01:30 del 23 a Roma
      body: "Late note.",
    });
    as("p-roberta");
    const today = await listPeopleActivity(TODAY);
    expect(today.find((p) => p.personId === "p-laura")?.comments.map((c) => c.id)).toContain(
      "a-late",
    );
    const before = await listPeopleActivity("2026-10-22");
    expect(
      before.find((p) => p.personId === "p-laura")?.comments.map((c) => c.id) ?? [],
    ).not.toContain("a-late");
  });
});
