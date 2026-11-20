import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alerts, listNotifications, productDocs, resetApi, setLatency } from "../api";
import { classOf } from "../claude/classes";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { withoutSeed11b } from "../seed/productDocs/without11b";
import { applyProductSource } from "./claude";

// Le notifiche della doc di prodotto nel catalogo degli avvisi (area 11,
// D-6 = b, maintainer 19 nov 2026) con N-1 = a (maintainer, 20 nov 2026):
// - le menzioni arrivano SEMPRE a chi è menzionato (obbligo `mentioned`) e
//   non hanno una riga da spegnere;
// - aggiornamenti e domande hanno la riga del progetto in Preferenze →
//   Notifiche, che decide per tutte le pagine (iscrizione con `docs.view`,
//   accesa di partenza per chi ha `docs.edit`);
// - «Follow» su una pagina li fa arrivare SEMPRE, anche con la riga spenta
//   (obbligo `follower`).
// Mai Claude, mai chi ha agito.

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

/** Una email di Laura attribuita ad ACQ, e il fatto che Claude ne scrive nella pagina. */
function updateFromLaurasEmail(id: string) {
  state.mailMessages.push(
    mail({
      id,
      threadId: `th-${id}`,
      from: ext("Fabio Rossi", "fabio@cliente.example"),
      to: [person(LAURA)],
      subject: "Subject",
      at: "2026-11-04T09:30:00Z",
      text: "body",
      mailboxPersonIds: [LAURA],
      classification: done([ACQ], "normal"),
    } as never),
  );
  applyProductSource({ kind: "email", id }, ACQ, [
    {
      id: `fact-${id}`,
      pageId: SIGN_IN,
      clarity: "clear",
      anchorId: SIGN_IN_PARA,
      change: { kind: "replace", text: { text: "Customers sign in with Google only.", marks: [] } },
    },
  ]);
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("doc di prodotto nel catalogo degli avvisi (area 11, D-6 = b, N-1 = a)", () => {
  it("nelle Preferenze di Marco in ACQ: le menzioni sempre (nessun interruttore), aggiornamenti e domande accese", async () => {
    as(MARCO);
    const rows = (await alerts.subscriptionRows()).find((p) => p.projectId === ACQ)!.rows;
    expect(rows.find((r) => r.type === "product_doc.mention")).toMatchObject({
      group: "docs",
      state: "mandatory",
      mandatory: ["mentioned"],
    });
    for (const type of ["product_doc.updated", "product_doc.question"]) {
      expect(rows.find((r) => r.type === type), type).toMatchObject({
        group: "docs",
        state: "on",
        app: true,
        mandatory: ["follower"],
      });
    }
  });

  it("le menzioni arrivano sempre a chi è menzionato, e solo a lui", async () => {
    as(LAURA);
    await productDocs.addProductComment(SIGN_IN, {
      anchorId: SIGN_IN_PARA,
      quote: "Google account",
      body: "@Matteo Conti please check",
    });
    expect((await inbox(MATTEO, "product_doc.mention")).at(-1)).toMatchObject({
      projectId: ACQ,
      mandatory: [{ personId: MATTEO, reason: "mentioned" }],
    });
    const marcos = (await inbox(MARCO, "product_doc.mention")).filter((n) => n.body.includes("Matteo"));
    expect(marcos).toEqual([]);
    expect((await inbox(LAURA, "product_doc.mention")).filter((n) => n.body.includes("Matteo"))).toEqual([]);
  });

  it("la riga spenta in Preferenze toglie gli aggiornamenti di tutte le pagine del progetto, a chi non segue", async () => {
    withoutSeed11b();
    follows([]);
    as(MARCO);
    await alerts.setSubscription(ACQ, "product_doc.updated", { app: false });
    const marcoBefore = (await inbox(MARCO, "product_doc.updated")).length;
    const lauraBefore = (await inbox(LAURA, "product_doc.updated")).length;
    updateFromLaurasEmail("mm-laura-1");
    // Laura non segue la pagina e ha la riga accesa (di partenza, ha docs.edit).
    expect(await inbox(LAURA, "product_doc.updated")).toHaveLength(lauraBefore + 1);
    expect(await inbox(MARCO, "product_doc.updated")).toHaveLength(marcoBefore);
  });

  it("«Follow» vince sulla riga spenta: Marco segue la pagina e riceve l'aggiornamento, per obbligo", async () => {
    withoutSeed11b();
    follows([MARCO]);
    as(MARCO);
    await alerts.setSubscription(ACQ, "product_doc.updated", { app: false });
    const before = (await inbox(MARCO, "product_doc.updated")).length;
    updateFromLaurasEmail("mm-laura-2");
    const mine = await inbox(MARCO, "product_doc.updated");
    expect(mine).toHaveLength(before + 1);
    expect(mine.at(-1)).toMatchObject({ mandatory: [{ personId: MARCO, reason: "follower" }] });
  });

  it("la classe di Claude conta i seguaci e gli iscritti: Marco spento senza seguire non c'è, seguendo sì", async () => {
    withoutSeed11b();
    const update = {
      fn: "updateProductPage" as const,
      args: { pageId: SIGN_IN, source: { kind: "email", id: "mm-acq-signin-google" } },
    };
    follows([]);
    as(MARCO);
    await alerts.setSubscription(ACQ, "product_doc.updated", { app: false });
    const notifies = () =>
      (classOf(MATTEO, update).reasons.find((r) => r.kind === "notifies") as { personIds: string[] } | undefined)
        ?.personIds ?? [];
    expect(notifies()).toContain(LAURA);
    expect(notifies()).not.toContain(MARCO);
    follows([MARCO]);
    expect(notifies()).toContain(MARCO);
  });
});
