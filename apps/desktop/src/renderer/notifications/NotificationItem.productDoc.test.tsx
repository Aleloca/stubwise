import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listNotifications, productDocs, resetApi, setLatency } from "../data/api";
import { setSessionPersonId } from "../data/session";
import { state } from "../data/store";
import type { AppNotification } from "../data/types";
import { ViewerProvider } from "../data/viewer";
import i18n from "../i18n";
import { createAppRouter } from "../router";
import { renderWithData } from "../test/renderWithData";
import { ThemeProvider } from "../theme/ThemeProvider";
import { NotificationItem } from "./NotificationItem";

// `product_doc.mention` nel pannello (area 11a, Task 4, Q1; shape
// product-comments-history §3.9): titolo composto a lettura nella lingua di
// chi guarda dai valori stabili (chi ha scritto, il codice, il titolo di
// adesso della pagina), corpo = il testo del commento con le menzioni in
// 600. Pagina o commento che non ci sono più: una frase generica, nessun
// codice né titolo, nessun link (R-G5).

const LAURA = "p-laura";
const MARCO = "p-marco";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const signIn = () => state.productPages.find((p) => p.title === "Sign-in")!;

async function marcoCard(): Promise<AppNotification> {
  setSessionPersonId(MARCO);
  const cards = (await listNotifications()).filter((n) => n.kind === "product_doc.mention");
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

function renderItem(n: AppNotification) {
  return renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "ACQ", name: "Portale utenti Acquedotto delle Colline" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId: MARCO },
  );
}

const itemText = () =>
  (document.querySelector("[data-notification]")?.textContent ?? "").replace(/\s+/g, " ");

describe("product_doc.mention: la card", () => {
  it("in en: «Laura Costa mentioned you in ACQ-D<n> · Sign-in», il testo del commento, «Product»", async () => {
    const n = await marcoCard();
    renderItem(n);
    const code = signIn().code;
    expect(itemText()).toContain(`Laura Costa mentioned you in ${code} · Sign-in`);
    expect(itemText()).toContain("@Marco Bellini");
    expect(document.querySelector("[data-object-code]")!.textContent).toBe(code);
    expect(itemText()).toContain("Product");
    // La menzione in 600 nel corpo.
    const strong = [...document.querySelectorAll("[data-mention]")].map((el) => el.textContent);
    expect(strong).toEqual(["@Marco Bellini"]);
    expect(document.querySelector("[data-object-code]")!.closest("button")).not.toBeNull();
  });

  it("in it: «Laura Costa ti ha menzionato in ACQ-D<n> · Sign-in»", async () => {
    const n = await marcoCard();
    await i18n.changeLanguage("it");
    renderItem(n);
    expect(itemText()).toContain(`Laura Costa ti ha menzionato in ${signIn().code} · Sign-in`);
    expect(itemText()).toContain("Prodotto");
    expect(itemText()).not.toContain("mentioned");
  });

  it("la pagina rinominata: il titolo di adesso", async () => {
    const page = signIn();
    setSessionPersonId(LAURA);
    await productDocs.renameProductPage(page.id, "Signing in");
    renderItem(await marcoCard());
    expect(itemText()).toContain(`mentioned you in ${page.code} · Signing in`);
  });

  it("la pagina eliminata: «A comment you were mentioned in», niente codice né titolo, non apre", async () => {
    const code = signIn().code;
    setSessionPersonId(LAURA);
    await productDocs.deleteProductPage(signIn().id);
    const n = await marcoCard();
    expect(n.objectGone).toBe(true);
    renderItem(n);
    expect(itemText()).toContain("A comment you were mentioned in");
    expect(itemText()).toContain("This comment is no longer available.");
    expect(itemText().toLowerCase()).not.toContain("sign-in");
    expect(itemText()).not.toContain(code);
    expect(itemText()).not.toContain("Laura Costa");
    // Non apre niente: la riga principale non è un bottone, e il codice non c'è.
    expect(document.querySelector("[data-notification] > button")).toBeNull();
    expect(document.querySelector("[data-object-code]")).toBeNull();
    document.body.innerHTML = "";
    await i18n.changeLanguage("it");
    renderItem(n);
    expect(itemText()).toContain("Un commento in cui eri menzionato");
    expect(itemText()).toContain("Questo commento non è più disponibile.");
  });

  it("una riga senza i campi nuovi (`productComment`, `productPageTitle`) resta com'è salvata", () => {
    renderItem({
      id: "n-old",
      kind: "product_doc.mention",
      projectId: "prj-acq",
      objectCode: "ACQ-D5",
      departmentId: null,
      recipientIds: [MARCO],
      title: "Saved title",
      body: "Saved body.",
      createdAt: "2026-11-01T09:00:00Z",
      read: false,
      archived: false,
      snoozedUntil: null,
      link: "#/p/ACQ/docs/product/ACQ-D5",
    });
    expect(itemText()).toContain("Saved title");
    expect(itemText()).toContain("Saved body.");
  });
});

describe("un kind che la UI di oggi non conosce", () => {
  it("non rompe l'elenco: la riga si legge com'è salvata, e le altre ci sono", async () => {
    state.notifications.push({
      id: "n-future",
      // Un valore dell'enum che arriverà dopo (11b o oltre): la UI non lo sa comporre.
      kind: "product_doc.something_new",
      projectId: "prj-acq",
      objectCode: "ACQ-D5",
      departmentId: null,
      recipientIds: [MARCO],
      title: "A future notice",
      body: "Its saved body.",
      createdAt: "2026-11-05T08:00:00Z",
      read: false,
      archived: false,
      snoozedUntil: null,
      link: "#/p/ACQ/overview",
    });
    setSessionPersonId(MARCO);
    const history = createMemoryHistory({ initialEntries: ["/home"] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ViewerProvider initialPersonId={MARCO}>
          <ThemeProvider>
            <RouterProvider router={createAppRouter(history)} />
          </ThemeProvider>
        </ViewerProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(await within(panel).findByText("A future notice")).toBeInTheDocument();
    expect(
      within(panel).getByText(`Laura Costa mentioned you in ${signIn().code} · Sign-in`),
    ).toBeInTheDocument();
  });
});
