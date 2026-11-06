import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProductTree, flattenTree } from "../../domain/productDocs/tree";
import { productDocs, resetApi, setLatency } from "../api";
import type { FirstVersionSource, MailMessage } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { VRD_FIRST_VERSION, VRD_IDS } from "../seed/productDocs/vrdFirstVersion";
import { now, state } from "../store";
import {
  acceptFirstVersionPageAs,
  firstVersionSourcesFor,
  openProductQuestions,
  productFirstVersionOf,
  startFirstVersionAs,
  undoFirstVersionAs,
  whenFirstVersionIdle,
} from "./firstVersion";
import { listProductMarksAs } from "./marks";
import { answerProductQuestionAs } from "./questions";
import { productPageRef } from "./reads";
import { createProductPageAs, deleteProductPageAs, writeProductBlocksAs } from "./writes";

// La prima versione di Claude (11b, Task 6): in uno spazio Prodotto vuoto
// chi ha `docs.edit` sceglie le fonti, e Claude scrive l'albero pagina per
// pagina, per conto di chi l'ha chiesta (`via: "claude"`, revisione
// `first_version`, nessun segno). In cima a ogni pagina una riga che
// sparisce quando la si accetta; «Annulla» toglie tutto insieme, finché
// nessuno ha toccato una pagina.
//
// VRD (seme 11a): vuoto, Laura Project Lead, Marco Developer (entrambi
// `docs.edit`), Sara Contributor (legge soltanto). La sua email del seme è
// nella casella di Laura (con Matteo in copia).

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const VRD: string = VRD_IDS.projectId;
const STW = "prj-stw";

const EMAIL: FirstVersionSource = { kind: "email", id: VRD_IDS.lauraEmailId };
const TEXT: FirstVersionSource = {
  kind: "text",
  text: "Notes from the call: classes are booked a week ahead.",
};
const DRIVE: FirstVersionSource = { kind: "drive", fileId: VRD_IDS.driveFileId };

const pagesOf = (projectId = VRD) => state.productPages.filter((p) => p.projectId === projectId);
const treeTitles = (projectId = VRD) =>
  flattenTree(buildProductTree(pagesOf(projectId).map(productPageRef))).map((n) => n.page.title);
const pageTitled = (title: string) => pagesOf().find((p) => p.title === title)!;
const questionsOf = (projectId = VRD) => {
  const ids = new Set(pagesOf(projectId).map((p) => p.id));
  return state.productComments.filter((c) => ids.has(c.pageId) && c.question !== undefined);
};
const textOf = (projectId: string) =>
  JSON.stringify(pagesOf(projectId).map((p) => p.blocks)).toLowerCase();

async function written(sources: readonly FirstVersionSource[] = [EMAIL, TEXT, DRIVE]) {
  const out = startFirstVersionAs(LAURA, VRD, sources);
  await whenFirstVersionIdle();
  return out;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(async () => {
  await whenFirstVersionIdle();
  resetApi();
});

describe("la stesura", () => {
  it("l'albero nasce pagina per pagina, ogni pagina `first_version` per conto di Laura, che le segue tutte", async () => {
    const seen: number[] = [];
    const stop = productDocs.onProductFirstVersion((projectId) => {
      if (projectId === VRD) seen.push(productFirstVersionOf(LAURA, VRD)!.pagesDone);
    });
    const { groupId } = startFirstVersionAs(LAURA, VRD, [EMAIL, TEXT]);

    const at0 = productFirstVersionOf(LAURA, VRD)!;
    expect(at0).toMatchObject({ status: "writing", pagesDone: 0, byId: LAURA, groupId });
    expect(at0.pagesTotal).toBe(VRD_FIRST_VERSION.length);
    expect(at0.pages.map((p) => p.state)).toEqual(
      VRD_FIRST_VERSION.map((_, i) => (i === 0 ? "writing" : "waiting")),
    );
    // Niente è scritto subito: la prima pagina arriva al primo passo.
    expect(pagesOf()).toHaveLength(0);

    await whenFirstVersionIdle();
    stop();
    const total = at0.pagesTotal;
    // L'avvio, poi una pagina per avviso, fino alla fine.
    expect([...new Set(seen)]).toEqual(Array.from({ length: total + 1 }, (_, i) => i));

    const end = productFirstVersionOf(LAURA, VRD)!;
    expect(end).toMatchObject({ status: "done", pagesDone: total, interrupted: false });
    expect(end.pages.every((p) => p.state === "written" && p.pageId !== null)).toBe(true);
    expect(treeTitles()).toEqual(VRD_FIRST_VERSION.map((p) => p.title));
    expect(pagesOf()).toHaveLength(total);

    for (const page of pagesOf()) {
      const revs = state.productRevisions.filter(
        (r) => r.pageId === page.id && r.kind === "first_version",
      );
      expect(revs, page.title).toHaveLength(1);
      expect(revs[0]).toMatchObject({
        via: "claude",
        actorId: LAURA,
        groupId,
        source: { kind: "first_version", ids: [`email:${VRD_IDS.lauraEmailId}`, "text"] },
      });
      expect(state.productFollows.some((f) => f.pageId === page.id && f.personId === LAURA)).toBe(
        true,
      );
    }
    // Il testo incollato non si conserva: la fonte lo nomina senza corpo.
    expect(JSON.stringify(state.productFirstVersions)).not.toContain(
      "classes are booked a week ahead",
    );
  });

  it("la bozza di VRD: due immagini, il file del Drive scelto, e nessun segno sulle frasi", async () => {
    await written();
    const blocks = pagesOf().flatMap((p) => p.blocks);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(
      blocks
        .filter((b) => b.type === "image")
        .every((b) => b.type === "image" && b.src.startsWith("data:image/png;base64,")),
    ).toBe(true);
    expect(blocks.filter((b) => b.type === "drive")).toEqual([
      expect.objectContaining({ type: "drive", fileId: VRD_IDS.driveFileId, code: "VRD-F1" }),
    ]);
    for (const page of pagesOf())
      expect(listProductMarksAs(LAURA, page.id), page.title).toEqual([]);
    const ids = new Set(pagesOf().map((p) => p.id));
    expect(state.productMarks.filter((m) => ids.has(m.pageId))).toEqual([]);
  });

  it("senza il file del Drive fra le fonti, la bozza non lo cita", async () => {
    await written([EMAIL]);
    expect(
      pagesOf()
        .flatMap((p) => p.blocks)
        .filter((b) => b.type === "drive"),
    ).toEqual([]);
  });

  it("le fonti della riga in cima come le legge chi guarda: Sara non legge l'oggetto dell'email", async () => {
    await written();
    const laura = productFirstVersionOf(LAURA, VRD)!;
    expect(laura.sources.map((s) => s.kind)).toEqual(["email", "text", "drive"]);
    expect(laura.sources[0]!.label).toMatchObject({ key: "productDocs.source.email" });
    expect(laura.sources[1]!.label).toEqual({ key: "productDocs.source.text" });
    expect(laura.sources[2]).toMatchObject({
      code: "VRD-F1",
      label: { key: "productDocs.source.drive" },
    });
    const sara = productFirstVersionOf(SARA, VRD)!;
    expect(sara.sources[0]).toMatchObject({
      label: { key: "productDocs.source.emailOf", params: { owner: "Laura Costa" } },
      link: null,
    });
    const subject = state.mailMessages.find((m) => m.id === VRD_IDS.lauraEmailId)!.subject;
    expect(JSON.stringify(sara).toLowerCase()).not.toContain(subject.toLowerCase());
    expect(JSON.stringify(sara).toLowerCase()).not.toContain(VRD_IDS.lauraEmailId);
    expect(sara.byName).toBe("Laura Costa");
  });

  it("un file del Drive nascosto dopo: chi non lo vede legge solo il codice, tenue", async () => {
    await written([DRIVE]);
    state.driveFiles.find((f) => f.id === VRD_IDS.driveFileId)!.hidden = true;
    const drive = productFirstVersionOf(SARA, VRD)!.sources[0]!;
    expect(drive).toMatchObject({
      kind: "drive",
      code: "VRD-F1",
      label: { key: "productDocs.source.driveHidden" },
      at: null,
      gone: false,
    });
    expect(JSON.stringify(drive).toLowerCase()).not.toContain("brief");
    state.driveFiles = state.driveFiles.filter((f) => f.id !== VRD_IDS.driveFileId);
    expect(productFirstVersionOf(SARA, VRD)!.sources[0]).toMatchObject({ gone: true, code: null });
  });
});

describe("la riga in cima e «Accetta»", () => {
  it("ogni pagina ha la riga finché Laura non la accetta; un secondo clic non scrive; Sara no", async () => {
    await written();
    const ids = pagesOf().map((p) => p.id);
    expect(new Set(productFirstVersionOf(LAURA, VRD)!.bannerPageIds)).toEqual(new Set(ids));

    acceptFirstVersionPageAs(LAURA, ids[0]!);
    acceptFirstVersionPageAs(LAURA, ids[0]!);
    const view = productFirstVersionOf(LAURA, VRD)!;
    expect(view.acceptedPageIds).toEqual([ids[0]]);
    expect(view.bannerPageIds).not.toContain(ids[0]);
    expect(view.bannerPageIds).toHaveLength(ids.length - 1);
    // Accettare non è toccare: «Annulla» resta acceso.
    expect(view.undo).toEqual({ enabled: true });

    expect(() => acceptFirstVersionPageAs(SARA, ids[1]!)).toThrow("forbidden");
    expect(productFirstVersionOf(LAURA, VRD)!.acceptedPageIds).toEqual([ids[0]]);
  });

  it("una pagina che non è della prima versione: `invalid: page`", async () => {
    await written();
    expect(() => acceptFirstVersionPageAs(LAURA, "pp-acq-sign-in")).toThrow("invalid: page");
  });
});

describe("le domande della bozza", () => {
  it("sono commenti-domanda di Claude, senza card, e `openProductQuestions` le conta", async () => {
    await written();
    const qs = questionsOf();
    expect(qs).toHaveLength(3);
    for (const q of qs) {
      expect(q.authorId).toBe(CLAUDE_ID);
      expect(q.question).toMatchObject({ answer: null, sourceRef: { kind: "first_version" } });
      expect(["apply", "keep", "request"]).toContain(q.question!.recommended);
    }
    const ids = new Set(pagesOf().map((p) => p.id));
    expect(
      state.notifications.filter((n) => n.productQuestion && ids.has(n.productQuestion.pageId)),
    ).toEqual([]);

    const open = openProductQuestions(LAURA, VRD);
    expect(open.count).toBe(3);
    expect(open.items.map((i) => i.commentId).sort()).toEqual(qs.map((q) => q.id).sort());
    for (const item of open.items) {
      const q = qs.find((c) => c.id === item.commentId)!;
      const page = pagesOf().find((p) => p.id === q.pageId)!;
      expect(item).toEqual({
        commentId: q.id,
        pageId: page.id,
        pageCode: page.code,
        pageTitle: page.title,
        quote: q.quote,
      });
    }

    // Chi non ha `docs.edit` non ha domande da chiudere.
    expect(openProductQuestions(SARA, VRD)).toEqual({ count: 0, items: [] });

    answerProductQuestionAs(LAURA, qs[0]!.id, "keep");
    expect(openProductQuestions(LAURA, VRD).count).toBe(2);
  });
});

describe("«Annulla la prima versione»", () => {
  it("toglie tutte le pagine con le domande, e i codici non si riusano", async () => {
    await written();
    const codes = pagesOf().map((p) => p.code);
    const pageIds = new Set(pagesOf().map((p) => p.id));
    expect(productFirstVersionOf(LAURA, VRD)!.undo).toEqual({ enabled: true });

    undoFirstVersionAs(LAURA, VRD);

    expect(pagesOf()).toEqual([]);
    expect(state.productComments.filter((c) => pageIds.has(c.pageId))).toEqual([]);
    expect(state.productRevisions.filter((r) => pageIds.has(r.pageId))).toEqual([]);
    expect(productFirstVersionOf(LAURA, VRD)!).toMatchObject({
      status: "undone",
      bannerPageIds: [],
      undo: { enabled: false, reason: "already_undone", byId: LAURA },
    });
    expect(openProductQuestions(LAURA, VRD).count).toBe(0);
    // Il secondo clic non scrive.
    expect(() => undoFirstVersionAs(LAURA, VRD)).toThrow("refused: already_undone");

    const fresh = createProductPageAs(LAURA, VRD, { title: "Start" });
    expect(codes).not.toContain(fresh.code);
    expect(fresh.code).toBe(`VRD-D${codes.length + 1}`);
  });

  it("dopo un tocco di Marco è spento col suo «Who?», e non toglie niente", async () => {
    await written();
    const memberships = pageTitled("Memberships");
    const block = memberships.blocks.find((b) => b.type === "paragraph")!;
    if (block.type !== "paragraph") throw new Error("paragraph");
    const edited = { ...block, content: { text: "Monthly and yearly plans.", marks: [] } };
    writeProductBlocksAs(MARCO, memberships.id, [{ op: "set", block: edited }], {});

    const view = productFirstVersionOf(LAURA, VRD)!;
    expect(view.undo).toEqual({
      enabled: false,
      reason: "changed_after",
      byId: MARCO,
      pageId: memberships.id,
      pageTitle: "Memberships",
    });
    expect(() => undoFirstVersionAs(LAURA, VRD)).toThrow("refused: changed_after");
    expect(pagesOf()).toHaveLength(VRD_FIRST_VERSION.length);
  });

  it("una pagina nuova nello spazio, non di Claude, conta come un tocco", async () => {
    await written();
    const extra = createProductPageAs(MARCO, VRD, { title: "Marco's notes" });
    expect(productFirstVersionOf(LAURA, VRD)!.undo).toMatchObject({
      enabled: false,
      reason: "changed_after",
      byId: MARCO,
      pageId: extra.id,
    });
  });

  it("chi legge soltanto: nessun permesso, e `forbidden`", async () => {
    await written();
    const sara = productFirstVersionOf(SARA, VRD)!;
    expect(sara.permissions).toEqual({ edit: false });
    expect(sara.undo).toEqual({ enabled: false, reason: "no_permission", byId: null });
    expect(() => undoFirstVersionAs(SARA, VRD)).toThrow("forbidden");
    expect(pagesOf()).toHaveLength(VRD_FIRST_VERSION.length);
  });
});

describe("i rifiuti", () => {
  it("Sara (solo lettura): `forbidden`, niente scritto", () => {
    expect(() => startFirstVersionAs(SARA, VRD, [TEXT])).toThrow("forbidden");
    expect(state.productFirstVersions).toEqual([]);
  });

  it("uno spazio non vuoto, o una prima versione già in corso: `space_not_empty`", async () => {
    expect(() => startFirstVersionAs(LAURA, "prj-acq", [TEXT])).toThrow("space_not_empty");
    startFirstVersionAs(LAURA, VRD, [TEXT]);
    expect(() => startFirstVersionAs(MARCO, VRD, [TEXT])).toThrow("space_not_empty");
    await whenFirstVersionIdle();
    expect(state.productFirstVersions).toHaveLength(1);
  });

  it("nessuna fonte, o solo testo vuoto: `no_sources`", () => {
    expect(() => startFirstVersionAs(LAURA, VRD, [])).toThrow("no_sources");
    expect(() => startFirstVersionAs(LAURA, VRD, [{ kind: "text", text: "   " }])).toThrow(
      "no_sources",
    );
    expect(state.productFirstVersions).toEqual([]);
  });

  it("budget finito: `ai_blocked`, niente scritto; la coda in pausa non blocca il gesto (P48)", async () => {
    state.instance.simulate.budgetReached = true;
    expect(() => startFirstVersionAs(LAURA, VRD, [TEXT])).toThrow("ai_blocked");
    expect(state.productFirstVersions).toEqual([]);
    expect(pagesOf()).toEqual([]);

    state.instance.simulate.budgetReached = false;
    state.instance.queuePauses.push({ projectId: VRD, byId: "p-roberta", at: now() });
    await written([TEXT]);
    expect(pagesOf()).toHaveLength(VRD_FIRST_VERSION.length);
  });
});

describe("le fonti possibili", () => {
  it("solo ciò che chi chiede vede nel progetto: un'email che Laura non ha ricevuto non c'è", () => {
    const hidden: MailMessage = mail({
      id: "mm-vrd-only-marco",
      threadId: "th-vrd-only-marco",
      from: ext("Nadia Verdi", "nadia@palestraverde.example"),
      to: [person(MARCO)],
      subject: "Locker rooms for the morning classes",
      at: "2026-11-02T09:00:00Z",
      text: "body",
      mailboxPersonIds: [MARCO],
      classification: done([VRD], "normal"),
    });
    state.mailMessages.push(hidden);

    const laura = firstVersionSourcesFor(LAURA, VRD);
    expect(laura.emails.map((e) => e.id)).toContain(VRD_IDS.lauraEmailId);
    expect(laura.emails.map((e) => e.id)).not.toContain(hidden.id);
    expect(JSON.stringify(laura).toLowerCase()).not.toContain("locker rooms");
    expect(laura.files).toEqual([
      expect.objectContaining({ id: VRD_IDS.driveFileId, code: "VRD-F1" }),
    ]);
    expect(firstVersionSourcesFor(MARCO, VRD).emails.map((e) => e.id)).toContain(hidden.id);

    // Passata comunque, la fonte non vista non esiste per chi chiede.
    expect(() => startFirstVersionAs(LAURA, VRD, [{ kind: "email", id: hidden.id }])).toThrow(
      "invalid: source",
    );
    expect(state.productFirstVersions).toEqual([]);
  });

  it("chi non legge i Docs del progetto non ha fonti da scegliere", () => {
    expect(firstVersionSourcesFor("p-giulia", VRD)).toEqual({
      emails: [],
      meetings: [],
      files: [],
    });
  });
});

describe("la bozza generica", () => {
  it("un progetto senza bozza preparata: Overview, Features, Screens, Client decisions, Phases, con le fonti scelte", async () => {
    // STW non ha pagine di prodotto né una bozza preparata.
    const file = state.driveFiles.find((f) => f.projectId === STW && !f.hidden)!;
    startFirstVersionAs(LAURA, STW, [TEXT, { kind: "drive", fileId: file.id }]);
    await whenFirstVersionIdle();

    expect(treeTitles(STW)).toEqual([
      "Overview",
      "Features",
      "Screens",
      "Client decisions",
      "Phases",
    ]);
    const overview = pagesOf(STW).find((p) => p.title === "Overview")!;
    const text = JSON.stringify(overview.blocks).toLowerCase();
    expect(text).toContain("pasted notes");
    expect(text).toContain(file.code.toLowerCase());
    expect(overview.blocks).toContainEqual(
      expect.objectContaining({ type: "drive", fileId: file.id }),
    );
    expect(questionsOf(STW)).toEqual([]);
  });

  it("cita un'email per titolare e data, mai col suo oggetto: la pagina la legge tutto il progetto", async () => {
    state.mailMessages.push(
      mail({
        id: "mm-stw-laura-fv",
        threadId: "th-stw-laura-fv",
        from: ext("Ivo Gentile", "ivo@pixelforge.example"),
        to: [person(LAURA)],
        subject: "Secret roadmap for the spring",
        at: "2026-11-02T09:00:00Z",
        text: "body of the secret roadmap",
        mailboxPersonIds: [LAURA],
        classification: done([STW], "normal"),
      }),
    );
    startFirstVersionAs(LAURA, STW, [{ kind: "email", id: "mm-stw-laura-fv" }]);
    await whenFirstVersionIdle();
    expect(textOf(STW)).toContain("an email of laura costa (nov 2)");
    expect(textOf(STW)).not.toContain("secret roadmap");
  });
});

describe("il copione interrotto", () => {
  it("una pagina eliminata a metà: si ferma dov'è, senza eccezioni, le pagine scritte restano", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let deleted: string | null = null;
    const stop = productDocs.onProductFirstVersion(() => {
      const view = productFirstVersionOf(LAURA, VRD)!;
      // Alla seconda pagina scritta Laura toglie la prima (Overview, senza figlie).
      if (view.pagesDone === 2 && deleted === null) {
        deleted = view.pages[0]!.pageId!;
        deleteProductPageAs(LAURA, deleted);
      }
    });
    startFirstVersionAs(LAURA, VRD, [TEXT]);
    await whenFirstVersionIdle();
    stop();

    const view = productFirstVersionOf(LAURA, VRD)!;
    expect(view).toMatchObject({ status: "done", pagesDone: 2, interrupted: true });
    expect(pagesOf().map((p) => p.title)).toEqual([VRD_FIRST_VERSION[1]!.title]);
    expect(view.bannerPageIds).toEqual([pagesOf()[0]!.id]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("lo store ripristinato a metà: nello stato nuovo non scrive niente", async () => {
    startFirstVersionAs(LAURA, VRD, [TEXT]);
    resetApi();
    setLatency(0);
    await whenFirstVersionIdle();
    expect(pagesOf()).toEqual([]);
    expect(state.productFirstVersions).toEqual([]);
  });
});
