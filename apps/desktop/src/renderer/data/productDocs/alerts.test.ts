import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alerts, listNotifications, productDocs, resetApi, setLatency } from "../api";
import { classOf } from "../claude/classes";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { withoutSeed11b } from "../seed/productDocs/without11b";
import { applyProductSource } from "./claude";

// Le notifiche della doc di prodotto nel catalogo degli avvisi (area 11,
// D-6 = b, decisione del maintainer del 19 nov 2026): Preferenze →
// Notifiche le elenca nella famiglia Docs, e chi non le vuole le spegne per
// progetto. I destinatari restano quelli che il produttore nomina (chi è
// menzionato, chi segue la pagina o il ripiego `docs.edit`): l'iscrizione
// li filtra, accesa di default per loro.

const LAURA = "p-laura";
const MARCO = "p-marco";
const MATTEO = "p-matteo";
const ACQ = "prj-acq";
const SIGN_IN = "pp-acq-sign-in";
const SIGN_IN_PARA = "blk-acq-signin-2";

const as = (personId: string) => setSessionPersonId(personId);
const inbox = async (personId: string, kind: string) => {
  as(personId);
  return (await listNotifications()).filter((n) => n.kind === kind);
};
const follows = (personIds: string[]) => {
  state.productFollows = state.productFollows.filter((f) => f.pageId !== SIGN_IN);
  for (const personId of personIds)
    state.productFollows.push({ pageId: SIGN_IN, personId, since: "2026-11-01T00:00:00Z" });
};

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("doc di prodotto nel catalogo degli avvisi (area 11, D-6 = b)", () => {
  it("nelle Preferenze di Marco in ACQ: menzioni, aggiornamenti e domande, nella famiglia Docs, accese", async () => {
    as(MARCO);
    const rows = (await alerts.subscriptionRows()).find((p) => p.projectId === ACQ)!.rows;
    for (const type of ["product_doc.mention", "product_doc.updated", "product_doc.question"]) {
      expect(
        rows.find((r) => r.type === type),
        type,
      ).toMatchObject({
        group: "docs",
        state: "on",
        app: true,
      });
    }
  });

  it("Marco spegne le menzioni in ACQ: Laura lo menziona e non gli arriva; a Matteo sì", async () => {
    as(MARCO);
    await alerts.setSubscription(ACQ, "product_doc.mention", { app: false });
    const before = (await inbox(MARCO, "product_doc.mention")).length;
    as(LAURA);
    await productDocs.addProductComment(SIGN_IN, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      body: "@Marco Bellini @Matteo Conti please check",
    });
    expect(await inbox(MARCO, "product_doc.mention")).toHaveLength(before);
    expect((await inbox(MATTEO, "product_doc.mention")).at(-1)).toMatchObject({ projectId: ACQ });
  });

  it("chi non è nominato non la riceve anche se iscritto: le menzioni restano di chi è menzionato", async () => {
    as(LAURA);
    await productDocs.addProductComment(SIGN_IN, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      body: "@Matteo Conti please check",
    });
    const mine = (await inbox(MARCO, "product_doc.mention")).filter(
      (n) =>
        n.productComment?.pageId === SIGN_IN &&
        n.actorName === "Laura Costa" &&
        n.body.includes("Matteo"),
    );
    expect(mine).toEqual([]);
  });

  it("Marco spegne gli aggiornamenti: la card dell'aggiornamento arriva a Laura, non a lui; la classe di Claude lo sa", async () => {
    withoutSeed11b();
    follows([LAURA, MARCO]);
    as(MARCO);
    await alerts.setSubscription(ACQ, "product_doc.updated", { app: false });
    const update = {
      fn: "updateProductPage" as const,
      args: { pageId: SIGN_IN, source: { kind: "email", id: "mm-acq-signin-google" } },
    };
    // Matteo chiede: avviserebbe Laura, non Marco.
    expect(classOf(MATTEO, update).reasons).toEqual([
      { kind: "notifies", personIds: [LAURA], more: false },
    ]);
    const marcoBefore = (await inbox(MARCO, "product_doc.updated")).length;
    const lauraBefore = (await inbox(LAURA, "product_doc.updated")).length;
    state.mailMessages.push(
      mail({
        id: "mm-laura-1",
        threadId: "th-mm-laura-1",
        from: ext("Fabio Rossi", "fabio@cliente.example"),
        to: [person(LAURA)],
        subject: "Subject",
        at: "2026-11-04T09:30:00Z",
        text: "body",
        mailboxPersonIds: [LAURA],
        classification: done([ACQ], "normal"),
      } as never),
    );
    applyProductSource({ kind: "email", id: "mm-laura-1" }, ACQ, [
      {
        id: "fact-alerts-1",
        pageId: SIGN_IN,
        clarity: "clear",
        anchorId: SIGN_IN_PARA,
        change: {
          kind: "replace",
          text: { text: "Customers sign in with Google only.", marks: [] },
        },
      },
    ]);
    expect(await inbox(LAURA, "product_doc.updated")).toHaveLength(lauraBefore + 1);
    expect(await inbox(MARCO, "product_doc.updated")).toHaveLength(marcoBefore);
  });
});
