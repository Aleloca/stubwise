import { beforeEach, describe, expect, it } from "vitest";
import {
  docs,
  productDocs,
  projectSettings,
  resetApi,
  resolveCitations,
  resolveCodes,
  searchMentions,
  setLatency,
} from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Le pagine di prodotto in ricerca, codici, menu «#», citazioni e chat del
// progetto (area 11a, Task 6). Persone del seme: Laura (Project Lead in ACQ),
// Sara (Contributor in ACQ: legge i Docs), Giulia (non è in ACQ). Nascosto e
// inesistente si leggono identici (R-G5): i confronti sono case-insensitive.

const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const page = (id: string) => state.productPages.find((p) => p.id === id)!;
const METER = "pp-acq-meter-reading";
const SIGN_IN = "pp-acq-sign-in";
const OVERVIEW = "pp-acq-overview";
const BILLS = "pp-acq-bills";

beforeEach(() => {
  resetApi();
  setLatency(0);
  as(LAURA);
});

describe("searchProductPages", () => {
  it("«readings 25th» come Laura e come Sara: Meter reading, col passaggio della frase", async () => {
    for (const who of [LAURA, SARA]) {
      as(who);
      const hits = await productDocs.searchProductPages("readings 25th");
      expect(hits.map((h) => h.page.id)).toEqual([METER]);
      expect(hits[0]).toMatchObject({
        projectCode: "ACQ",
        passage: "Readings close on the 25th of each month.",
        page: { code: page(METER).code, title: "Meter reading", projectId: ACQ },
      });
    }
  });

  it("chi non vede ACQ, o col modulo Docs spento: vuoto, identico a «nessun risultato»", async () => {
    const nothing = await productDocs.searchProductPages("zanzibar quokka");
    expect(nothing).toEqual([]);
    as(GIULIA);
    expect(await productDocs.searchProductPages("readings 25th")).toEqual(nothing);
    expect(await productDocs.searchProductPages("readings 25th", { projectId: ACQ })).toEqual(
      nothing,
    );
    as(LAURA);
    expect(await projectSettings.setDocsModule(ACQ, false)).toEqual({ ok: true });
    for (const who of [LAURA, SARA]) {
      as(who);
      expect(await productDocs.searchProductPages("readings 25th")).toEqual(nothing);
    }
  });

  it("una parola in grassetto si trova, l'indirizzo di un link no; il passaggio non ha segni", async () => {
    const [hit, ...rest] = await productDocs.searchProductPages("pay their bills");
    expect(rest).toEqual([]);
    expect(hit!.page.id).toBe(OVERVIEW);
    expect(hit!.passage).toContain("pay their bills");
    expect(hit!.passage).not.toMatch(/[*_[\]]|https?:/);
    // Il dominio sta solo nell'`href` del link: non è testo della pagina.
    expect(await productDocs.searchProductPages("acquedottocolline")).toEqual([]);
    expect(await productDocs.searchProductPages("carta-dei-servizi")).toEqual([]);
    // Il testo del link sì.
    expect((await productDocs.searchProductPages("utility's website")).map((h) => h.page.id)).toEqual(
      [OVERVIEW],
    );
  });

  it("accenti piegati, ogni parola, in codice, titolo e testo; `projectId` restringe", async () => {
    const code = page(SIGN_IN).code;
    expect((await productDocs.searchProductPages(code.toLowerCase())).map((h) => h.page.id)).toEqual(
      [SIGN_IN],
    );
    expect((await productDocs.searchProductPages("sígn-in")).map((h) => h.page.id)).toContain(
      SIGN_IN,
    );
    expect(await productDocs.searchProductPages("readings zanzibar")).toEqual([]);
    expect(await productDocs.searchProductPages("readings 25th", { projectId: "prj-aud" })).toEqual(
      [],
    );
  });
});

describe("codici, citazioni e menu «#»", () => {
  it("resolveCodes: una pagina di prodotto visibile apre la sua route; eliminata, come un codice che non c'è", async () => {
    const code = page(SIGN_IN).code;
    const [view, ...rest] = await resolveCodes([code]);
    expect(rest).toEqual([]);
    expect(view).toMatchObject({
      kind: "doc",
      id: SIGN_IN,
      visible: true,
      code,
      name: "Sign-in",
      projectCode: "ACQ",
      route: `#/p/ACQ/docs/product/${code}`,
    });
    // Chi non vede ACQ: niente, come un codice inventato.
    as(GIULIA);
    expect(await resolveCodes([code])).toEqual(await resolveCodes(["ACQ-D999"]));
    expect(await resolveCodes([code])).toEqual([]);
    // Eliminata: lo stesso.
    as(LAURA);
    const leaf = page("pp-acq-phases").code;
    expect(await resolveCodes([leaf])).toHaveLength(1);
    await productDocs.deleteProductPage("pp-acq-phases");
    expect(await resolveCodes([leaf])).toEqual([]);
  });

  it("resolveCitations: una pagina di prodotto che chi guarda non legge non porta nulla", async () => {
    as(GIULIA);
    const [view] = await resolveCitations([{ kind: "doc", id: METER }]);
    expect(view).toEqual({
      kind: "doc",
      id: METER,
      visible: false,
      code: null,
      name: null,
      projectCode: null,
      status: null,
      personId: null,
      route: null,
    });
  });

  it("menu «#» con «sign»: la pagina di prodotto, con lo spazio Prodotto (mai a chi non legge ACQ)", async () => {
    const found = (await searchMentions("sign", "objects")).filter(
      (r) => r.ref.kind === "doc" && r.ref.id === SIGN_IN,
    );
    expect(found).toEqual([
      {
        ref: { kind: "doc", id: SIGN_IN },
        code: page(SIGN_IN).code,
        label: "Sign-in",
        detail: "ACQ",
        projectId: ACQ,
        space: "product",
      },
    ]);
    as(GIULIA);
    const hers = JSON.stringify(await searchMentions("sign", "objects"));
    expect(hers.toLowerCase()).not.toContain("sign-in");
    expect(hers.toLowerCase()).not.toContain(page(SIGN_IN).code.toLowerCase());
  });
});

describe("chat dei Docs", () => {
  it("la chat del progetto ACQ cita Meter reading, con la fonte «product»", async () => {
    const answer = await docs.askDocs({
      projectId: ACQ,
      question: "How do meter readings work?",
    });
    expect(answer.refs[0]).toEqual({ kind: "doc", id: METER });
    expect(answer.text).toContain(page(METER).code);
    expect(answer.sources[0]).toEqual({ pageId: METER, repositoryName: "", space: "product" });
  });

  it("la chat del repository portale-utenti risponde dai suoi Docs e non cita le pagine di prodotto", async () => {
    const project = await docs.askDocs({ projectId: ACQ, question: "How do bills work?" });
    // Nel progetto la domanda trova anche la pagina di prodotto Bills…
    expect(project.refs).toContainEqual({ kind: "doc", id: BILLS });
    const repo = await docs.askDocs({
      projectId: ACQ,
      repositoryId: "repo-acq",
      question: "How do bills work?",
    });
    // …nel repository risponde la pagina dei Docs, e nessuna di prodotto.
    expect(repo.refs).toEqual([{ kind: "doc", id: "doc-acq-test-accounts" }]);
    expect(repo.sources).toEqual([
      { pageId: "doc-acq-test-accounts", repositoryName: "portale-utenti" },
    ]);
    const productIds = new Set(state.productPages.map((p) => p.id));
    expect(repo.refs.some((r) => productIds.has(r.id))).toBe(false);
    expect(repo.text).not.toMatch(/ACQ-D(?:[3-9]|1[01])\b/);
  });

  it("Sara, che legge soltanto, riceve la stessa fonte; col modulo spento la chat non c'è", async () => {
    as(SARA);
    const answer = await docs.askDocs({ projectId: ACQ, question: "How do meter readings work?" });
    expect(answer.refs[0]).toEqual({ kind: "doc", id: METER });
    as(LAURA);
    await projectSettings.setDocsModule(ACQ, false);
    await expect(
      docs.askDocs({ projectId: ACQ, question: "How do meter readings work?" }),
    ).rejects.toThrow("not_found");
  });
});
