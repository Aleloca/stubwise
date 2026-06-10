import { expect, test, type Page } from "@playwright/test";

/*
 * Flussi core contro lo stack reale (server Fastify + Postgres effimero,
 * vedi playwright.config.ts): setup admin → progetto → ticket → dettaglio →
 * board (drag reale) → logout/login.
 *
 * Un solo describe seriale con UNA pagina condivisa: ogni step costruisce lo
 * stato per il successivo, come farebbe una persona. Il database è unico per
 * l'intera run e nasce vuoto.
 */

const ADMIN_EMAIL = "ada@example.com";
const ADMIN_PASSWORD = "password-sicura-e2e";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("primo setup: crea l'admin e atterra sulla lista ticket vuota", async () => {
  await page.goto("/");
  // Istanza vergine: la guardia porta al primo setup.
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Conferma password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Crea account" }).click();

  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByText("// nessun ticket trovato")).toBeVisible();
});

test("crea un progetto con credenziali e vede chiave di ingestion e snippet", async () => {
  await page.getByRole("link", { name: /projects/i }).click();
  await expect(page.getByText("// nessun progetto collegato")).toBeVisible();

  await page.getByRole("link", { name: "Nuovo progetto" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);

  await page.getByLabel("Nome").fill("Demo Shop");
  await page.getByLabel("Provider").selectOption("github");
  await page.getByLabel("URL repository").fill("https://github.com/acme/demo-shop");
  await page.getByLabel("Token di accesso").fill("ghp_token_di_prova");
  await page.getByRole("button", { name: "Crea progetto" }).click();

  // Sul dettaglio: slug generato, chiave di ingestion (32 hex) e DSN/snippet.
  await expect(page).toHaveURL(/\/projects\/demo-shop$/);
  const key = page.locator("code", { hasText: /^[0-9a-f]{32}$/ }).first();
  await expect(key).toBeVisible();
  const ingestionKey = (await key.textContent())!;
  await expect(
    page.locator("code", { hasText: `${ingestionKey}@localhost:5210/p/demo-shop` }).first(),
  ).toBeVisible();
  const snippet = page.getByTestId("init-snippet");
  await expect(snippet).toContainText('import { init } from "@stubwise/sdk/browser"');
  await expect(snippet).toContainText(`/p/demo-shop`);
  // Il token git non deve comparire da nessuna parte.
  await expect(page.locator("body")).not.toContainText("ghp_token_di_prova");
});

test("crea un ticket dal dialog e lo ritrova in lista", async () => {
  await page.getByRole("link", { name: /tickets/i }).click();
  await page.getByRole("button", { name: "Nuovo ticket" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo ticket" });
  await dialog.getByLabel("Titolo").fill("Crash al checkout");
  await dialog.getByLabel("Progetto").selectOption({ label: "Demo Shop" });
  await dialog.getByLabel("Tipo").selectOption("bug");
  await dialog.getByLabel("Priorità").selectOption("high");
  await dialog.getByLabel("Descrizione (opzionale)").fill("Il pagamento esplode al submit.");
  await dialog.getByRole("button", { name: "Crea ticket" }).click();

  await expect(dialog).toBeHidden();
  const row = page.getByRole("link", { name: /crash al checkout/i });
  await expect(row).toBeVisible();
  await expect(row).toContainText("#1");
});

test("dettaglio: cambia stato dal select e aggiunge un commento", async () => {
  await page.getByRole("link", { name: /crash al checkout/i }).click();
  await expect(page.getByRole("heading", { name: "Crash al checkout" })).toBeVisible();

  const patched = page.waitForResponse(
    (response) => response.url().includes("/api/tickets/") && response.request().method() === "PATCH",
  );
  await page.getByLabel("Stato").selectOption("in_progress");
  expect((await patched).status()).toBe(200);

  await page.getByLabel("Aggiungi un commento").fill("Indago io, sembra il gateway.");
  await page.getByRole("button", { name: "Commenta" }).click();
  await expect(page.getByText("Indago io, sembra il gateway.")).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL).nth(1)).toBeVisible();
});

test("board: trascina la card in un'altra colonna e lo stato persiste", async () => {
  await page.getByRole("link", { name: /board/i }).click();

  const card = page.locator("li", { hasText: "Crash al checkout" }).first();
  const fromColumn = page.getByRole("region", { name: /In corso/ });
  const toColumn = page.getByRole("region", { name: /In review/ });
  await expect(fromColumn.locator("li", { hasText: "Crash al checkout" })).toBeVisible();

  // Drag reale col mouse: il PointerSensor di dnd-kit si attiva oltre 8px.
  const cardBox = (await card.boundingBox())!;
  const targetBox = (await toColumn.boundingBox())!;
  const patched = page.waitForResponse(
    (response) => response.url().includes("/api/tickets/") && response.request().method() === "PATCH",
  );
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();

  expect((await patched).status()).toBe(200);
  await expect(toColumn.locator("li", { hasText: "Crash al checkout" })).toBeVisible();

  // Persistenza: dopo un reload la card è ancora nella colonna di arrivo.
  await page.reload();
  await expect(
    page.getByRole("region", { name: /In review/ }).locator("li", { hasText: "Crash al checkout" }),
  ).toBeVisible();
});

test("board: il click semplice sulla card apre il dettaglio (niente drag)", async () => {
  // Pinna la soppressione del click di dnd-kit: sotto gli 8px è un click.
  await page
    .getByRole("region", { name: /In review/ })
    .locator("li", { hasText: "Crash al checkout" })
    .click();

  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Crash al checkout" })).toBeVisible();
  await expect(page.getByLabel("Stato")).toHaveValue("in_review");
});

test("logout e login: la sessione si chiude e si riapre", async () => {
  await page.getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // La sessione è davvero chiusa: una pagina protetta riporta al login.
  await page.goto("/tickets");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Accedi" }).click();

  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByRole("link", { name: /crash al checkout/i })).toBeVisible();
});
