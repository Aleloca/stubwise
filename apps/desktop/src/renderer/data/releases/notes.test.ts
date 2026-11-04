import { beforeEach, describe, expect, it } from "vitest";
import { releases, resetApi, setLatency } from "../api";
import { sees } from "../access";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { releaseNotesDraftFor } from "./notes";

// Le note di rilascio delle PR (area 10b, Task 8, S6b): la bozza di Claude
// (una riga per task, solo codici di task visibili) e la scrittura delle
// note sulla PR, che il merge copia sul rilascio. La bozza non si salva da
// sola: solo `setPrReleaseNotes`, il gesto della persona, scrive.

const ACQ_PR = "opr-acq-77";
const as = (personId: string) => setSessionPersonId(personId);
const pr = (id: string) => state.openPrs.find((p) => p.id === id)!;
const titleOf = (code: string) => state.tasks.find((t) => t.code === code)!.title;

beforeEach(() => {
  resetApi();
  setLatency(0);
});

describe("releaseNotesDraftFor", () => {
  it("sulla PR del seme: due righe, ognuna col suo codice; il commit senza codice non c'è", () => {
    const draft = releaseNotesDraftFor("p-laura", ACQ_PR)!;
    expect(draft.sources).toEqual(["ACQ-7", "ACQ-2"]);
    expect(draft.text).toBe(
      [`- ACQ-7: ${titleOf("ACQ-7")}`, `- ACQ-2: ${titleOf("ACQ-2")}`].join("\n"),
    );
    // Il commit «Update the dependencies…» non cita nessuna task: nessuna riga.
    expect(draft.text.toLowerCase()).not.toContain("dependencies");
  });

  it("un codice di una task invisibile o eliminata non c'è (in minuscolo)", () => {
    const commits = pr(ACQ_PR).commits!;
    // Una task di un progetto che Laura non vede (precondizione) e una eliminata.
    const hidden = state.tasks.find((t) => !sees("p-laura", t.projectId))!;
    commits.push(
      { sha: "c".repeat(40), message: `${hidden.code}: ${hidden.title}` },
      { sha: "d".repeat(40), message: "ACQ-3: issue the invoices" },
    );
    const acq3 = state.tasks.find((t) => t.code === "ACQ-3")!;
    state.tasks = state.tasks.filter((t) => t.id !== acq3.id);
    state.tasksById.delete(acq3.id);
    const draft = releaseNotesDraftFor("p-laura", ACQ_PR)!;
    const json = JSON.stringify(draft).toLowerCase();
    expect(json).not.toContain(hidden.code.toLowerCase());
    expect(json).not.toContain(hidden.title.toLowerCase());
    expect(json).not.toContain("acq-3");
    expect(draft.sources).toEqual(["ACQ-7", "ACQ-2"]);
  });

  it("una task visibile di un altro progetto non entra nelle note della PR (I2)", () => {
    const other = state.tasks.find(
      (t) => t.projectId !== "prj-acq" && sees("p-laura", t.projectId),
    )!;
    pr(ACQ_PR).commits!.push({ sha: "e".repeat(40), message: `${other.code}: ${other.title}` });
    const draft = releaseNotesDraftFor("p-laura", ACQ_PR)!;
    expect(draft.sources).toEqual(["ACQ-7", "ACQ-2"]);
    expect(draft.text.toLowerCase()).not.toContain(other.code.toLowerCase());
  });

  it("`null` per chi non può modificare le note, e per una PR che chi chiede non vede", () => {
    // Sara vede ACQ, ma senza `tickets.edit` né `release.merge`.
    expect(releaseNotesDraftFor("p-sara", ACQ_PR)).toBeNull();
    // Giulia non vede ACQ: come una PR che non c'è (R-G5).
    expect(releaseNotesDraftFor("p-giulia", ACQ_PR)).toBeNull();
    expect(releaseNotesDraftFor("p-laura", "opr-none")).toBeNull();
  });
});

describe("setPrReleaseNotes", () => {
  it("Laura sì: le note sulla PR, e la vista dice che può modificarle", async () => {
    as("p-laura");
    const before = (await releases.listOpenPrs("prj-acq")).find((p) => p.id === ACQ_PR)!;
    expect(before.canEditReleaseNotes).toBe(true);
    // La fixture del seme senza il campo nuovo (cambi additivi).
    expect(before.releaseNotes).toBeUndefined();
    const view = await releases.setPrReleaseNotes(ACQ_PR, "- ACQ-7: Reminder");
    expect(view.releaseNotes).toBe("- ACQ-7: Reminder");
    expect(pr(ACQ_PR).releaseNotes).toBe("- ACQ-7: Reminder");
    // Vuote: `null`, non una stringa vuota.
    expect((await releases.setPrReleaseNotes(ACQ_PR, "   ")).releaseNotes).toBeNull();
  });

  it("un Contributor senza `tickets.edit` né `release.merge`: `forbidden`, e le note non cambiano", async () => {
    as("p-sara");
    const view = (await releases.listOpenPrs("prj-acq")).find((p) => p.id === ACQ_PR)!;
    expect(view.canEditReleaseNotes).toBe(false);
    await expect(releases.setPrReleaseNotes(ACQ_PR, "nope")).rejects.toThrow("forbidden");
    expect(pr(ACQ_PR).releaseNotes).toBeUndefined();
  });

  it("una PR di un progetto invisibile: `not_found`", async () => {
    as("p-giulia");
    await expect(releases.setPrReleaseNotes(ACQ_PR, "x")).rejects.toThrow("not_found");
    expect(pr(ACQ_PR).releaseNotes).toBeUndefined();
  });

  it("dopo `mergePr` il rilascio ha le note", async () => {
    as("p-laura");
    await releases.setPrReleaseNotes(ACQ_PR, "- ACQ-7: Reminder");
    const merged = await releases.mergePr(ACQ_PR);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.release!.releaseNotes).toBe("- ACQ-7: Reminder");
    const release = state.releases.find((r) => r.id === merged.release!.id)!;
    expect(release.releaseNotes).toBe("- ACQ-7: Reminder");
  });

  it("una PR mergiata senza note: il rilascio non ne ha", async () => {
    as("p-laura");
    const merged = await releases.mergePr(ACQ_PR);
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.release!.releaseNotes ?? null).toBeNull();
  });
});
