import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { applyProductSource, whenProductClaudeIdle } from "../../../data/productDocs/claude";
import { startFirstVersionAs, whenFirstVersionIdle } from "../../../data/productDocs/firstVersion";
import { answerProductQuestionAs } from "../../../data/productDocs/questions";
import { writeProductBlocksAs } from "../../../data/productDocs/writes";
import { done, ext, mail, person } from "../../../data/seed/mail/helpers";
import { VRD_IDS } from "../../../data/seed/productDocs/vrdFirstVersion";
import { withoutSeed11b } from "../../../data/seed/productDocs/without11b";
import { state } from "../../../data/store";
import type { MailMessage, ProductBlock, ProductFact, RichText } from "../../../data/types";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { REDUCED_MOTION_QUERY } from "../../../layout/useMediaQuery";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// Le righe di Claude nella cronologia (11b, Task 9; shape
// product-claude-mark.md §3.6): «Claude on behalf of …» con l'anello sotto
// l'ora e la fonte; «Undo» / «Undo all» coi loro stati (Review Focus 4: se
// anche una frase l'ha toccata un altro, «Undo all» è spento e si annulla
// una per una); «Undone by …» sulla riga annullata e la riga «Undid Claude's
// change»; la risposta a una domanda («Laura Costa, from Claude's
// question»); la prima versione, che si annulla dalla riga in cima.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const ACQ = "prj-acq";
const PAGE = "pp-acq-sign-in";
const H1 = "blk-acq-signin-1";
const HOW = "blk-acq-signin-2";
const STORES = "blk-acq-signin-4";

const plain = (text: string): RichText => ({ text, marks: [] });
const pageOf = (id = PAGE) => state.productPages.find((p) => p.id === id)!;
const textOf = (id: string) => {
  const b = pageOf().blocks.find((x) => x.id === id);
  return b && "content" in b ? b.content.text : null;
};
const undoRevisions = () => state.productRevisions.filter((r) => r.pageId === PAGE && r.kind === "undo");

function email(id: string): MailMessage {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: [person(LAURA)],
    subject: "Login: confirmation",
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: [LAURA],
    classification: done([ACQ], "normal"),
  });
}

let n = 0;
const replace = (anchorId: string, text: string): ProductFact => ({
  id: `fact-hist-${++n}`,
  pageId: PAGE,
  anchorId,
  clarity: "clear",
  change: { kind: "replace", text: plain(text) },
});

/** Claude riscrive tre frasi di Sign-in in UNA revisione, per conto di Laura. */
function threeChanges(): string {
  withoutSeed11b();
  state.mailMessages.push(email("mm-hist-1"));
  const out = applyProductSource({ kind: "email", id: "mm-hist-1" }, ACQ, [
    replace(H1, "How customers sign in, with Google only"),
    replace(HOW, "Customers sign in with Google only."),
    replace(STORES, "Only the name and the email address."),
  ]);
  return out.edits[0]!;
}

function marcoEdits(blockId: string, text: string) {
  const block = pageOf().blocks.find((b) => b.id === blockId)!;
  writeProductBlocksAs(MARCO, PAGE, [{ op: "set", block: { ...block, content: plain(text) } as ProductBlock }], {
    sessionId: "s-marco",
  });
}

async function openHistory(path: string, title: string, personId = LAURA) {
  renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1, name: title });
  const user = userEvent.setup();
  const bar = screen.getByRole("navigation", { name: /^(Product pages of|Pagine di prodotto di) [A-Z]+$/ });
  await user.click(within(bar).getByRole("button", { name: /^(History|Cronologia)$/ }));
  const region = await screen.findByRole("region", { name: /^(History|Cronologia)$/ });
  await within(region).findByRole("list", { name: /^(Changes to this page|Modifiche a questa pagina)$/ });
  return { region, user };
}

const rowsOf = (region: HTMLElement) => [...region.querySelectorAll<HTMLElement>("[data-history-row]")];
const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
/** La voce intera di una riga (il bottone, la fonte, i suoi «Undo», il dettaglio). */
const itemOf = (row: HTMLElement) => row.closest("li")!;
const claudeItem = (region: HTMLElement) =>
  itemOf(rowsOf(region).find((r) => flat(r).includes("on behalf of") || flat(r).includes("per conto di"))!);

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  for (const p of [LAURA, MARCO, SARA]) window.localStorage.setItem(`stubwise.productComments.${p}`, "closed");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await whenProductClaudeIdle();
  await whenFirstVersionIdle();
  act(() => setLanguage("en"));
});

describe("la riga di una modifica di Claude", () => {
  it("«Claude on behalf of Laura Costa», l'anello «Made with Claude», «Edited 3 sentences», la fonte e «Undo all»", async () => {
    threeChanges();
    const { region } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    const item = claudeItem(region);
    const text = flat(item);
    expect(text).toContain("Claude on behalf of Laura Costa");
    expect(text).toContain("Edited 3 sentences");
    expect(text).toContain("From the email “Login: confirmation”");
    expect(within(item).getByTitle("Made with Claude")).toBeInTheDocument();
    const all = within(item).getByRole("button", { name: /^Undo all$/ });
    expect(all).not.toHaveAttribute("aria-disabled");
  });

  it("«Undo all»: tutte le frasi tornano, «Undone by Laura Costa» sulla riga, «Undid Claude's change» in cima; il fuoco resta sulla riga", async () => {
    threeChanges();
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    await user.click(within(claudeItem(region)).getByRole("button", { name: /^Undo all$/ }));
    await waitFor(() => expect(textOf(HOW)).not.toBe("Customers sign in with Google only."));
    expect(textOf(STORES)).not.toBe("Only the name and the email address.");
    const item = await waitFor(() => {
      const it = claudeItem(region);
      expect(flat(it)).toContain("Undone by Laura Costa");
      return it;
    });
    expect(within(item).queryByRole("button", { name: /^Undo all$/ })).toBeNull();
    const top = rowsOf(region)[0]!;
    expect(flat(top)).toContain("Laura Costa");
    expect(flat(top)).toContain("Undid Claude's change");
    expect(flat(itemOf(top))).toMatch(/Undid: Claude on behalf of Laura Costa · Edited 3 sentences · /);
    await waitFor(() => expect(item.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
    expect(undoRevisions()).toHaveLength(1);
  });

  it("«Undid: …»: la data porta alla riga annullata e la tinge 1,5 s; col movimento ridotto la tinta resta finché la riga ha il fuoco (Fix round 1)", async () => {
    setMatchMedia(REDUCED_MOTION_QUERY, true);
    threeChanges();
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    await user.click(within(claudeItem(region)).getByRole("button", { name: /^Undo all$/ }));
    await waitFor(() => expect(flat(rowsOf(region)[0]!)).toContain("Undid Claude's change"));
    await user.click(within(itemOf(rowsOf(region)[0]!)).getByRole("button", { name: /^Show the change that was undone/ }));
    const undone = rowsOf(region).find((r) => flat(r).includes("on behalf of") && flat(itemOf(r)).includes("Undone by"))!;
    await waitFor(() => expect(document.activeElement).toBe(undone));
    expect(undone).toHaveAttribute("data-flash");
    await new Promise((r) => setTimeout(r, 1700));
    // Fermo: la tinta non se ne va col tempo, solo col fuoco.
    expect(undone).toHaveAttribute("data-flash");
    rowsOf(region)[0]!.focus();
    await waitFor(() => expect(undone).not.toHaveAttribute("data-flash"));
  });

  it("senza movimento ridotto la tinta se ne va dopo 1,5 s", async () => {
    threeChanges();
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    await user.click(within(claudeItem(region)).getByRole("button", { name: /^Undo all$/ }));
    await waitFor(() => expect(flat(rowsOf(region)[0]!)).toContain("Undid Claude's change"));
    await user.click(within(itemOf(rowsOf(region)[0]!)).getByRole("button", { name: /^Show the change that was undone/ }));
    const undone = rowsOf(region).find((r) => flat(r).includes("on behalf of") && flat(itemOf(r)).includes("Undone by"))!;
    await waitFor(() => expect(undone).toHaveAttribute("data-flash"));
    await waitFor(() => expect(undone).not.toHaveAttribute("data-flash"), { timeout: 2500 });
    expect(document.activeElement).toBe(undone);
  });

  it("un doppio clic su «Undo all» fa una sola scrittura", async () => {
    threeChanges();
    setLatency(60);
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    const calls = vi.spyOn(api.productDocs, "undoProductChange");
    await user.dblClick(within(claudeItem(region)).getByRole("button", { name: /^Undo all$/ }));
    await waitFor(() => expect(flat(claudeItem(region))).toContain("Undone by Laura Costa"), { timeout: 3000 });
    expect(undoRevisions()).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("Review Focus 4: Marco ha toccato una frase — «Undo all» spento con chi, le altre si annullano una per una", async () => {
    threeChanges();
    marcoEdits(HOW, "Marco's own sentence.");
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    const item = claudeItem(region);
    const all = within(item).getByRole("button", { name: /^Undo all$/ });
    expect(all).toHaveAttribute("aria-disabled", "true");
    expect(all).toHaveAccessibleDescription("Marco Bellini edited one afterwards. Undo the others one by one.");
    await user.click(all);
    expect(undoRevisions()).toHaveLength(0);

    // Aperta: un «Undo» per ancora, quello di Marco spento col suo nome.
    await user.click(rowsOf(region).find((r) => itemOf(r) === item)!);
    const undos = within(item).getAllByRole("button", { name: /^Undo$/ });
    expect(undos).toHaveLength(3);
    const off = undos.filter((b) => b.getAttribute("aria-disabled") === "true");
    expect(off).toHaveLength(1);
    expect(off[0]).toHaveAccessibleDescription("Marco Bellini edited it afterwards");

    const on = undos.filter((b) => b.getAttribute("aria-disabled") !== "true");
    await user.click(on[0]!);
    await waitFor(() => expect(flat(claudeItem(region))).toContain("1 of 3 undone · Laura Costa"));
    // Il testo di Marco resta suo.
    expect(textOf(HOW)).toBe("Marco's own sentence.");
    expect(within(claudeItem(region)).getByText(/^Undone$/)).toBeInTheDocument();
    expect(undoRevisions()).toHaveLength(1);
  });

  it("Sara: la riga si legge, nessun «Undo» e nessuna frase", async () => {
    threeChanges();
    const { region, user } = await openHistory(
      "/p/ACQ/docs/product/ACQ-D5",
      "Sign-in",
      SARA,
    );
    const item = claudeItem(region);
    await user.click(rowsOf(region).find((r) => itemOf(r) === item)!);
    expect(within(item).queryByRole("button", { name: /^Undo( all)?$/ })).toBeNull();
    expect(flat(item)).not.toContain("Only people who can edit");
    expect(flat(item)).toContain("From an email of Laura Costa");
  });

  it("in italiano: «Claude per conto di Laura Costa», «Fatta con Claude», «Annulla tutto»", async () => {
    act(() => setLanguage("it"));
    threeChanges();
    const { region } = await openHistory("/p/ACQ/docs/product/ACQ-D5", "Sign-in");
    const item = claudeItem(region);
    expect(flat(item)).toContain("Claude per conto di Laura Costa");
    expect(within(item).getByTitle("Fatta con Claude")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: /^Annulla tutto$/ })).toBeInTheDocument();
  });
});

describe("il Claude collega (Fix round 1)", () => {
  it("una decisione portata da Claude: «Claude», l'avatar ad anello di Claude e «Made with Claude»", async () => {
    const { region } = await openHistory("/p/ACQ/docs/product/ACQ-D10", "Client decisions");
    const row = rowsOf(region).find((r) => r.querySelector("[data-claude-mark]"))!;
    expect(row).toBeDefined();
    expect(row.querySelector("[data-row-name]")?.textContent).toBe("Claude");
    expect(row.querySelector("[data-claude-ring]")).not.toBeNull();
    expect(within(row).getByTitle("Made with Claude")).toBeInTheDocument();
  });
});

describe("la risposta a una domanda e la prima versione", () => {
  it("«Laura Costa, from Claude's question» senza anello né «Undo»; «See the question» apre il filo", async () => {
    answerProductQuestionAs(LAURA, "pc-acq11b-meter-q", "apply");
    const { region, user } = await openHistory("/p/ACQ/docs/product/ACQ-D7", "Meter reading");
    const row = rowsOf(region).find((r) => flat(r).includes("from Claude's question"))!;
    expect(flat(row)).toContain("Laura Costa, from Claude's question");
    const item = itemOf(row);
    expect(within(item).queryByTitle("Made with Claude")).toBeNull();
    expect(within(item).queryByRole("button", { name: /^Undo( all)?$/ })).toBeNull();
    await user.click(within(item).getByRole("button", { name: /^See the question$/ }));
    const comments = await screen.findByRole("region", { name: /^Comments$/ });
    await waitFor(() => expect(comments.contains(document.activeElement)).toBe(true));
  });

  it("la prima versione: «Wrote the first version», le fonti, «Undo it from the line at the top of the page», nessun «Undo»", async () => {
    startFirstVersionAs(LAURA, VRD_IDS.projectId, [
      { kind: "email", id: VRD_IDS.lauraEmailId },
      { kind: "text", text: "Classes are booked a week ahead." },
    ]);
    await whenFirstVersionIdle();
    const page = state.productPages.find((p) => p.projectId === VRD_IDS.projectId && p.parentId === null)!;
    const { region } = await openHistory(`/p/VRD/docs/product/${page.code}`, page.title);
    const row = rowsOf(region).find((r) => flat(r).includes("Wrote the first version"))!;
    const item = itemOf(row);
    expect(flat(row)).toContain("Claude on behalf of Laura Costa");
    expect(within(item).getByTitle("Made with Claude")).toBeInTheDocument();
    expect(flat(item)).toContain("From pasted text");
    expect(flat(item)).toContain("Undo it from the line at the top of the page");
    expect(within(item).queryByRole("button", { name: /^Undo( all)?$/ })).toBeNull();
  });
});
