import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listNotifications, productDocs, resetApi, setLatency } from "../data/api";
import { writeAccess } from "../data/access/state";
import { setSessionPersonId } from "../data/session";
import { state } from "../data/store";
import type { AppNotification } from "../data/types";
import i18n from "../i18n";
import { renderWithData } from "../test/renderWithData";
import { NotificationItem } from "./NotificationItem";

// Le due card del 11b nel pannello (Task 10; shape product-claude-mark.md
// §3.7, product-claude-questions.md §3.5): titolo e corpo composti a
// lettura nella lingua di chi guarda dai valori stabili di `productCard`;
// la fonte nella forma di chi RICEVE (Marco non ha l'email di Laura: «From
// an email of Laura Costa», mai l'oggetto, R-G5 e decisione 1); la card per
// pagina con più fonti; `objectGone`; una fixture senza i campi nuovi non
// lancia.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SUBJECT = "Portal sign-in: Google accounts only";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  cleanup();
  resetApi();
  await i18n.changeLanguage("en");
});

const page = (title: string) => state.productPages.find((p) => p.title === title)!;

async function cardsOf(person: string, kind: AppNotification["kind"]): Promise<AppNotification[]> {
  setSessionPersonId(person);
  return (await listNotifications()).filter((n) => n.kind === kind);
}

async function cardFor(person: string, kind: AppNotification["kind"], pageTitle: string) {
  const code = page(pageTitle).code;
  const card = (await cardsOf(person, kind)).find((n) => n.objectCode === code);
  expect(card, `${kind} su ${pageTitle} per ${person}`).toBeDefined();
  return card!;
}

function renderItem(n: AppNotification, personId: string) {
  return renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "ACQ", name: "Portale utenti Acquedotto delle Colline" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId },
  );
}

const item = () => document.querySelector<HTMLElement>("[data-notification]")!;
const itemText = () => (item().textContent ?? "").replace(/\s+/g, " ");
/** Tutto ciò che il nodo porta, testo e attributi, in minuscolo (R-G5). */
const everything = () => item().outerHTML.toLowerCase();

describe("product_doc.updated", () => {
  it("Laura, che ha l'email: «Claude updated ACQ-D<n> · Sign-in», «on behalf of Laura Costa», la fonte con l'oggetto, «Product»", async () => {
    const n = await cardFor(LAURA, "product_doc.updated", "Sign-in");
    renderItem(n, LAURA);
    const code = page("Sign-in").code;
    expect(itemText()).toContain(`Claude updated ${code} · Sign-in`);
    expect(itemText()).toMatch(/Claude on behalf of Laura Costa changed \d+ sentences?\./);
    expect(itemText()).toContain(`From the email “${SUBJECT}”`);
    expect(itemText()).toContain("Product");
    expect(document.querySelector("[data-object-code]")!.textContent).toBe(code);
  });

  it("Marco, che non ha l'email: «from an email of Laura Costa», nessuna parola dell'oggetto in nessun nodo", async () => {
    const n = await cardFor(MARCO, "product_doc.updated", "Sign-in");
    renderItem(n, MARCO);
    expect(itemText().toLowerCase()).toContain("from an email of laura costa");
    expect(everything()).not.toContain("google accounts only");
    expect(everything()).not.toContain("portal sign-in");
  });

  it("in it: «Claude ha aggiornato …», «per conto di Laura Costa», «da un'email di laura costa» per Marco", async () => {
    const n = await cardFor(MARCO, "product_doc.updated", "Sign-in");
    await i18n.changeLanguage("it");
    renderItem(n, MARCO);
    expect(itemText()).toContain(`Claude ha aggiornato ${page("Sign-in").code} · Sign-in`);
    expect(itemText()).toMatch(/Claude per conto di Laura Costa ha cambiato \d+ fras[ei]\./);
    expect(itemText().toLowerCase()).toContain("da un'email di laura costa");
    expect(itemText()).toContain("Prodotto");
  });

  it("una decisione del registro (Claude, senza «per conto di»): «Claude changed 1 sentence. From the decision …»", async () => {
    const n = await cardFor(LAURA, "product_doc.updated", "Client decisions");
    renderItem(n, LAURA);
    expect(itemText()).toContain("Claude changed 1 sentence.");
    expect(itemText()).toContain("From the decision “");
    expect(itemText()).not.toContain("on behalf of");
  });

  it("la card per pagina con due fonti, dopo il budget: la frase delle fonti e una riga per fonte, nessun «on behalf of»", async () => {
    const signIn = page("Sign-in");
    state.notifications.push({
      id: "n-two-sources",
      kind: "product_doc.updated",
      projectId: "prj-acq",
      objectCode: signIn.code,
      departmentId: null,
      recipientIds: [LAURA],
      title: "",
      body: "",
      link: "",
      createdAt: "2026-11-06T10:14:00Z",
      read: false,
      archived: false,
      snoozedUntil: null,
      productUpdate: {
        pageId: signIn.id,
        revisionIds: ["prev-acq11b-signin"],
        sources: [
          { kind: "email", id: "mm-acq-signin-google" },
          { kind: "task", id: "t-acq-8" },
        ],
        waited: "monthly_budget",
      },
    });
    const n = (await cardsOf(LAURA, "product_doc.updated")).find((x) => x.id === "n-two-sources")!;
    renderItem(n, LAURA);
    expect(itemText()).toMatch(/Claude changed \d+ sentences? from 2 sources, after waiting for the budget\./);
    expect(itemText()).not.toContain("on behalf of");
    const lines = item().querySelectorAll("[data-card-source]");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain(`From the email “${SUBJECT}”`);
    expect(lines[1]!.textContent).toContain("ACQ-8");
  });

  it("il clic porta al segno ancora a vista (`?mark=`); senza segni, alla riga della cronologia (`?history=`)", async () => {
    const signIn = page("Sign-in");
    const n = await cardFor(LAURA, "product_doc.updated", "Sign-in");
    expect(n.link).toMatch(new RegExp(`/docs/product/${signIn.code}\\?mark=`));
    for (const m of state.productMarks.filter((x) => x.pageId === signIn.id)) m.acceptedById = LAURA;
    const again = await cardFor(LAURA, "product_doc.updated", "Sign-in");
    expect(again.link).toMatch(new RegExp(`/docs/product/${signIn.code}\\?history=prev-acq11b-signin$`));
  });

  it("`objectGone` (la pagina non c'è più): «A product page Claude updated», nessun codice, titolo, fonte né link", async () => {
    const signIn = page("Sign-in");
    productDocs.deleteProductPageAs(LAURA, signIn.id);
    const n = (await cardsOf(MARCO, "product_doc.updated")).find((x) => x.objectGone)!;
    renderItem(n, MARCO);
    expect(itemText()).toContain("A product page Claude updated");
    expect(itemText()).toContain("This page is no longer available.");
    expect(document.querySelector("[data-object-code]")).toBeNull();
    expect(everything()).not.toContain("sign-in");
    expect(everything()).not.toContain("laura costa");
    expect(item().querySelector("button")?.textContent ?? "").not.toContain("Claude updated");
  });

  it("una fixture senza `productUpdate` né `productCard` non lancia: titolo e corpo del caso sparito", () => {
    renderItem(
      {
        id: "n-old",
        kind: "product_doc.updated",
        projectId: "prj-acq",
        objectCode: "",
        departmentId: null,
        recipientIds: [LAURA],
        title: "",
        body: "",
        link: "",
        createdAt: "2026-11-06T10:14:00Z",
        read: true,
        archived: false,
        snoozedUntil: null,
      },
      LAURA,
    );
    expect(itemText()).toContain("A product page Claude updated");
    expect(itemText()).toContain("This page is no longer available.");
  });
});

describe("product_doc.question", () => {
  it("Laura: «Claude asks about ACQ-D<n> · Bills», la domanda e la fonte; nessun bottone di risposta", async () => {
    const n = await cardFor(LAURA, "product_doc.question", "Bills");
    renderItem(n, LAURA);
    expect(itemText()).toContain(`Claude asks about ${page("Bills").code} · Bills`);
    expect(itemText()).toContain("The source isn't clear on this. Should the page say this?");
    expect(itemText()).toMatch(/From (the|a) meeting/);
    expect(item().textContent).not.toContain("Update it");
    expect(item().textContent).not.toContain("Leave it as is");
    expect(n.link).toContain("?comment=pc-acq11b-bills-q");
  });

  it("la divergenza da una task chiusa nomina il codice; in it «Claude chiede su …»", async () => {
    const n = await cardFor(LAURA, "product_doc.question", "Meter reading");
    await i18n.changeLanguage("it");
    renderItem(n, LAURA);
    expect(itemText()).toContain(`Claude chiede su ${page("Meter reading").code} · Meter reading`);
    // Senza richiesta da proporre la frase non la offre (fix round 1, I4).
    expect(itemText()).toContain("ACQ-8 è stata fatta diversamente da come dice la pagina. Aggiorno la pagina?");
    expect(itemText()).not.toContain("apro una richiesta");
  });

  it("fix round 1, I4: con una richiesta da proporre, «…or open a request?» (en)", async () => {
    state.productComments.find((c) => c.id === "pc-acq11b-meter-q")!.question!.request = {
      title: "Lower readings after a meter change",
      description: "Decide whether a lower reading is accepted.",
    };
    const n = await cardFor(LAURA, "product_doc.question", "Meter reading");
    renderItem(n, LAURA);
    expect(itemText()).toContain(
      "ACQ-8 was built differently from what the page says. Should I update the page, or open a request?",
    );
  });

  it("risposta già data: «Answered by Laura Costa» sotto il corpo, derivato a lettura", async () => {
    setSessionPersonId(LAURA);
    await productDocs.answerProductQuestion("pc-acq11b-bills-q", "keep");
    const n = await cardFor(LAURA, "product_doc.question", "Bills");
    renderItem(n, LAURA);
    expect(item().querySelector("[data-answered-by]")!.textContent).toBe("Answered by Laura Costa");
  });

  it("revisione finale, caso 9b: chi non vede più la persona nominata né chi ha risposto legge le frasi di riserva", async () => {
    const q = state.productComments.find((c) => c.id === "pc-acq11b-bills-q")!.question!;
    q.reason = "no_permission";
    q.forId = "p-sara";
    setSessionPersonId(MARCO);
    await productDocs.answerProductQuestion("pc-acq11b-bills-q", "keep");
    // Sara e Marco disattivati: Laura non li vede più (`visiblePeopleFor`).
    writeAccess((s) => {
      for (const p of s.people) if (p.personId === "p-sara" || p.personId === MARCO) p.status = "deactivated";
    });
    const n = await cardFor(LAURA, "product_doc.question", "Bills");
    expect(n.productCard!.question).toMatchObject({ forName: null, answeredByName: null });
    renderItem(n, LAURA);
    expect(itemText()).toContain("This came from someone who can't edit the Docs");
    expect(item().querySelector("[data-answered-by]")!.textContent).toBe("Answered");
    for (const name of ["sara montanari", "marco bellini"]) expect(everything()).not.toContain(name);
  });

  it("`objectGone` e la fixture senza `productQuestion`: «A question from Claude», nessun codice", () => {
    renderItem(
      {
        id: "n-old-q",
        kind: "product_doc.question",
        projectId: "prj-acq",
        objectCode: "",
        departmentId: null,
        recipientIds: [LAURA],
        title: "",
        body: "",
        link: "",
        createdAt: "2026-11-06T10:14:00Z",
        read: true,
        archived: false,
        snoozedUntil: null,
      },
      LAURA,
    );
    expect(itemText()).toContain("A question from Claude");
    expect(itemText()).toContain("This page is no longer available.");
    expect(document.querySelector("[data-object-code]")).toBeNull();
  });
});
