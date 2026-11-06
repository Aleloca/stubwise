import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { applyProductSource, whenProductClaudeIdle } from "../../../data/productDocs/claude";
import { writeProductBlocksAs } from "../../../data/productDocs/writes";
import { done, ext, mail, person } from "../../../data/seed/mail/helpers";
import { withoutSeed11b } from "../../../data/seed/productDocs/without11b";
import { state } from "../../../data/store";
import type { MailMessage, ProductBlock, ProductFact, RichText } from "../../../data/types";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// Il segno di Claude a margine di un blocco (11b, Task 9; shape
// product-claude-mark.md §3.2–§3.5): chiuso un bottone nella corsia di
// destra, aperto una nota sotto il blocco con chi, per conto di chi, quando,
// la fonte come la legge chi guarda, «Looks good» e «Undo» — o, per chi
// legge soltanto, la frase col «Who?». Il segno, i bottoni e le frasi
// vengono dal dato (`ProductMarkView`): la pagina non confronta revisioni.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ACQ = "prj-acq";
const PAGE = "pp-acq-sign-in";
const SIGNIN = "/p/ACQ/docs/product/ACQ-D5";
const HOW = "blk-acq-signin-2";
const STORES = "blk-acq-signin-4";
/** Il blocco che Claude ha aggiunto nel seme 11b, per conto di Laura, da una sua email. */
const SEEDED = "blk-acq-signin-5";
/** Un oggetto che non compare da nessun'altra parte (Review Focus 3). */
const SUBJECT = "Quokka zephyr: login confirmation";

const plain = (text: string): RichText => ({ text, marks: [] });
const pageOf = () => state.productPages.find((p) => p.id === PAGE)!;
const textOf = (id: string) => {
  const b = pageOf().blocks.find((x) => x.id === id);
  return b && "content" in b ? b.content.text : null;
};
const undoRevisions = () => state.productRevisions.filter((r) => r.pageId === PAGE && r.kind === "undo");

function email(id: string, mailbox: string[]): MailMessage {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: mailbox.map(person),
    subject: SUBJECT,
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: mailbox,
    classification: done([ACQ], "normal"),
  });
}

let n = 0;
const replace = (anchorId: string, text: string): ProductFact => ({
  id: `fact-mark-${++n}`,
  pageId: PAGE,
  anchorId,
  clarity: "clear",
  change: { kind: "replace", text: plain(text) },
});

/** Sign-in senza la storia del seme 11b, e Claude che riscrive due frasi da un'email di Laura. */
function twoChanges(): string {
  withoutSeed11b();
  state.mailMessages.push(email("mm-mark-1", [LAURA]));
  const out = applyProductSource({ kind: "email", id: "mm-mark-1" }, ACQ, [
    replace(HOW, "Customers sign in with Google only."),
    replace(STORES, "Only the name and the email address."),
  ]);
  return out.edits[0]!;
}

async function openPage(personId: string, path = SIGNIN) {
  renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1, name: "Sign-in" });
  return userEvent.setup();
}

const markOf = (blockId: string) =>
  document.querySelector<HTMLButtonElement>(`[data-claude-mark-button="${blockId}"]`);
const noteOf = (blockId: string) => document.querySelector<HTMLElement>(`[data-claude-note="${blockId}"]`);
const groupOf = (blockId: string) => document.querySelector<HTMLElement>(`[role="group"][data-block-id="${blockId}"]`);

async function openNote(user: ReturnType<typeof userEvent.setup>, blockId: string) {
  await waitFor(() => expect(markOf(blockId)).not.toBeNull());
  await user.click(markOf(blockId)!);
  await waitFor(() => expect(noteOf(blockId)).not.toBeNull());
  return noteOf(blockId)!;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  // Agganciata la colonna dei commenti si aprirebbe da sola: qui conta la lettura.
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  window.localStorage.setItem(`stubwise.productComments.${LAURA}`, "closed");
  window.localStorage.setItem(`stubwise.productComments.${MARCO}`, "closed");
  window.localStorage.setItem(`stubwise.productComments.${SARA}`, "closed");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await whenProductClaudeIdle();
  act(() => setLanguage("en"));
});

describe("il segno chiuso e aperto", () => {
  it("Laura: il segno a margine dice chi e per conto di chi; aperto, la nota con la fonte e il fuoco sulla prima riga", async () => {
    const user = await openPage(LAURA);
    await waitFor(() => expect(markOf(SEEDED)).not.toBeNull());
    const mark = markOf(SEEDED)!;
    expect(mark).toHaveAccessibleName("Updated by Claude on behalf of Laura Costa. Open the change.");
    expect(mark).toHaveAttribute("aria-expanded", "false");
    // Un blocco senza modifiche di Claude non ha segno.
    expect(markOf(HOW)).toBeNull();

    const note = await openNote(user, SEEDED);
    expect(mark).toHaveAttribute("aria-expanded", "true");
    expect(mark.getAttribute("aria-controls")).toBe(note.id);
    const text = (note.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Updated by Claude");
    expect(text).toContain("on behalf of Laura Costa");
    // Laura apre l'email: l'oggetto, che porta alla conversazione in Posta.
    const link = within(note).getByRole("link", { name: /^From the email “Portal sign-in: Google accounts only”/ });
    expect(link.getAttribute("href")).toMatch(/^#\/mail\//);
    // Una frase sola: niente «Part of a change to…».
    expect(text).not.toContain("Part of a change");
    expect(within(note).getByRole("button", { name: /^Looks good$/ })).toBeInTheDocument();
    expect(within(note).getByRole("button", { name: /^Undo$/ })).toBeInTheDocument();
    // Il fuoco sulla prima riga della nota, mai sul body.
    await waitFor(() => expect(note.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Esc chiude la nota e il fuoco torna al segno; il clic altrove non la chiude", async () => {
    const user = await openPage(LAURA);
    const note = await openNote(user, SEEDED);
    await user.click(screen.getByRole("heading", { level: 1, name: "Sign-in" }));
    expect(noteOf(SEEDED)).not.toBeNull();
    within(note).getByRole("button", { name: /^Looks good$/ }).focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(noteOf(SEEDED)).toBeNull());
    expect(document.activeElement).toBe(markOf(SEEDED));
  });

  it("chi scrive ci arriva anche dal menu del blocco: «Claude's change», solo sul blocco col segno", async () => {
    const user = await openPage(LAURA);
    await waitFor(() => expect(markOf(SEEDED)).not.toBeNull());
    await user.click(within(groupOf(HOW)!).getByRole("button", { name: /^Block menu · / }));
    expect(screen.queryByRole("menuitem", { name: "Claude's change" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(within(groupOf(SEEDED)!).getByRole("button", { name: /^Block menu · / }));
    await user.click(screen.getByRole("menuitem", { name: "Claude's change" }));
    await waitFor(() => expect(noteOf(SEEDED)).not.toBeNull());
    await waitFor(() => expect(noteOf(SEEDED)!.contains(document.activeElement)).toBe(true));
  });

  it("più frasi nella stessa modifica: «Part of a change to 2 sentences · See it in the history» apre la cronologia", async () => {
    twoChanges();
    const user = await openPage(LAURA);
    const note = await openNote(user, HOW);
    expect(note.textContent).toContain("Part of a change to 2 sentences");
    await user.click(within(note).getByRole("button", { name: /^See it in the history$/ }));
    const region = await screen.findByRole("region", { name: /^History$/ });
    const row = await waitFor(() => {
      const open = region.querySelector<HTMLElement>('[data-history-row][aria-expanded="true"]');
      expect(open).not.toBeNull();
      return open!;
    });
    expect(row.textContent).toContain("Claude on behalf of Laura Costa");
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("in italiano: «Aggiornato da Claude per conto di Laura Costa. Apri la modifica.» e «Va bene» · «Annulla»", async () => {
    act(() => setLanguage("it"));
    const user = await openPage(LAURA);
    await waitFor(() => expect(markOf(SEEDED)).not.toBeNull());
    expect(markOf(SEEDED)).toHaveAccessibleName("Aggiornato da Claude per conto di Laura Costa. Apri la modifica.");
    const note = await openNote(user, SEEDED);
    expect(note.textContent).toContain("per conto di Laura Costa");
    expect(within(note).getByRole("button", { name: /^Va bene$/ })).toBeInTheDocument();
    expect(within(note).getByRole("button", { name: /^Annulla$/ })).toBeInTheDocument();
  });
});

describe("«Looks good» e «Undo»", () => {
  it("«Looks good»: il segno sparisce, l'annuncio, il fuoco al blocco", async () => {
    const user = await openPage(LAURA);
    const note = await openNote(user, SEEDED);
    await user.click(within(note).getByRole("button", { name: /^Looks good$/ }));
    await waitFor(() => expect(markOf(SEEDED)).toBeNull());
    expect(noteOf(SEEDED)).toBeNull();
    expect(state.productMarks.find((m) => m.anchorId === SEEDED)?.acceptedById).toBe(LAURA);
    await waitFor(() => expect(document.activeElement).toBe(groupOf(SEEDED)));
    expect(screen.getByText("Marked as reviewed")).toBeInTheDocument();
    // Il testo resta di Claude.
    expect(textOf(SEEDED)).toContain("Google is the only way in");
  });

  it("«Undo» su una frase riscritta: torna com'era, il fuoco va al blocco tornato, mai al body", async () => {
    twoChanges();
    const before = textOf(HOW);
    expect(before).toBe("Customers sign in with Google only.");
    const user = await openPage(LAURA);
    const note = await openNote(user, HOW);
    await user.click(within(note).getByRole("button", { name: /^Undo$/ }));
    await waitFor(() => expect(textOf(HOW)).not.toBe(before));
    await waitFor(() => expect(markOf(HOW)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(groupOf(HOW)));
    expect(screen.getByText("Undone: the sentence is back as it was")).toBeInTheDocument();
    // Solo quella frase: l'altra ha ancora il suo segno.
    expect(markOf(STORES)).not.toBeNull();
  });

  it("«Undo» di un blocco aggiunto da Claude: il blocco se ne va, il fuoco al blocco prima", async () => {
    const user = await openPage(LAURA);
    const note = await openNote(user, SEEDED);
    await user.click(within(note).getByRole("button", { name: /^Undo$/ }));
    await waitFor(() => expect(groupOf(SEEDED)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(groupOf(HOW)));
  });

  it("un doppio clic su «Undo» fa una sola scrittura", async () => {
    twoChanges();
    setLatency(60);
    const user = await openPage(LAURA);
    const note = await openNote(user, HOW);
    const undo = within(note).getByRole("button", { name: /^Undo$/ });
    // Anche il livello dati rifiuterebbe il secondo (`already_undone`): qui conta che la pagina non lo chieda.
    const calls = vi.spyOn(api.productDocs, "undoProductChange");
    await user.dblClick(undo);
    // In corso: spento con «Undoing…».
    await waitFor(() => expect(markOf(HOW)).toBeNull(), { timeout: 3000 });
    expect(undoRevisions()).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("«Undo» spento: «Marco Bellini edited it afterwards», col nome come chi, senza «Who?»", async () => {
    withoutSeed11b();
    state.mailMessages.push(email("mm-mark-1", [LAURA]));
    const cell = (id: string, text: string) => ({ id, content: plain(text) });
    const table: ProductBlock = {
      id: "blk-t",
      type: "table",
      rows: [
        { id: "blk-t-r1", cells: [cell("blk-t-a", "Meter"), cell("blk-t-b", "Reading")] },
        { id: "blk-t-r2", cells: [cell("blk-t-c", "Home"), cell("blk-t-d", "Cubic metres")] },
      ],
    };
    applyProductSource({ kind: "email", id: "mm-mark-1" }, ACQ, [
      { id: "fact-table", pageId: PAGE, anchorId: STORES, clarity: "clear", change: { kind: "insert_after", block: table } },
    ]);
    const inserted = pageOf().blocks[pageOf().blocks.findIndex((b) => b.id === STORES) + 1]!;
    if (inserted.type !== "table") throw new Error("not a table");
    const edited = structuredClone(inserted);
    edited.rows[0]!.cells[1]!.content = plain("Marco's reading");
    writeProductBlocksAs(MARCO, PAGE, [{ op: "set", block: edited }], { sessionId: "s-m" });

    const user = await openPage(LAURA);
    const note = await openNote(user, inserted.id);
    // Un segno per la tabella; aperto, una riga per cella.
    expect(note.textContent).toContain("Row 1, column 1");
    const undos = within(note).getAllByRole("button", { name: /^Undo$/ });
    expect(undos.length).toBeGreaterThan(0);
    for (const undo of undos) {
      expect(undo).toHaveAttribute("aria-disabled", "true");
      expect(undo).toHaveAccessibleDescription("Marco Bellini edited it afterwards");
    }
    // È un fatto, non un permesso: niente «Who?».
    expect(within(note).queryByText("Who?")).toBeNull();
    await user.click(undos[0]!);
    expect(undoRevisions()).toHaveLength(0);
  });
});

describe("chi legge soltanto", () => {
  it("Sara: nessun bottone, la frase «Only people who can edit the Docs…» col «Who?», la fonte senza oggetto né link", async () => {
    const user = await openPage(SARA);
    const note = await openNote(user, SEEDED);
    expect(within(note).queryByRole("button", { name: /^(Looks good|Undo)$/ })).toBeNull();
    expect(note.textContent).toContain("Only people who can edit the Docs in ACQ can accept or undo it.");
    expect(within(note).getByText("Who?").closest("button")).not.toBeNull();
    expect(note.textContent).toMatch(/From an email of Laura Costa · [A-Z][a-z]{2} \d+/);
    expect(within(note).queryByRole("link")).toBeNull();
  });

  it("Review Focus 3: per Sara nessuna parola dell'oggetto, in minuscolo, in tutta la pagina (segno aperto e cronologia)", async () => {
    twoChanges();
    const user = await openPage(SARA);
    await openNote(user, HOW);
    const bar = screen.getByRole("navigation", { name: /^Product pages of ACQ$/ });
    await user.click(within(bar).getByRole("button", { name: /^History$/ }));
    const region = await screen.findByRole("region", { name: /^History$/ });
    const rows = await waitFor(() => {
      const all = region.querySelectorAll<HTMLElement>("[data-history-row]");
      expect(all.length).toBeGreaterThan(0);
      return all;
    });
    for (const row of rows) await user.click(row);
    const html = document.documentElement.outerHTML.toLowerCase();
    for (const word of ["quokka", "zephyr", SUBJECT.toLowerCase()]) expect(html).not.toContain(word);
    expect(document.body.textContent?.toLowerCase()).toContain("from an email of laura costa");
  });

  it("in italiano, per Sara: «da un'email di laura costa» (P27)", async () => {
    act(() => setLanguage("it"));
    const user = await openPage(SARA);
    const note = await openNote(user, SEEDED);
    expect((note.textContent ?? "").toLowerCase()).toContain("da un'email di laura costa");
    expect(note.textContent).toContain("Solo chi può modificare i Docs di ACQ può accettarla o annullarla.");
    expect(within(note).getByText("Chi?").closest("button")).not.toBeNull();
  });
});

describe("l'indirizzo", () => {
  it("`?mark=<ancora>` apre la nota di quel blocco col fuoco sulla prima riga", async () => {
    await openPage(LAURA, `${SIGNIN}?mark=${SEEDED}`);
    await waitFor(() => expect(noteOf(SEEDED)).not.toBeNull());
    await waitFor(() => expect(noteOf(SEEDED)!.contains(document.activeElement)).toBe(true));
  });
});
