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

// Account git riutilizzabile creato INTERAMENTE dalla UI: Settings → Account Git
// → "Nuovo account git". Il form invia un POST reale con le credenziali; nello
// stack e2e sono finte (GitHub non viene mai contattato alla creazione), quindi
// l'account viene salvato e compare in lista. Le operazioni che decifrano e
// usano davvero le credenziali (validate, elenco repo/branch) fallirebbero: per
// questo la creazione del progetto usa il fallback manuale del wizard.
test("crea un account git dalla UI (Settings → Account Git)", async () => {
  await page.getByRole("link", { name: /settings/i }).click();
  await expect(page.getByRole("heading", { name: "Account Git" })).toBeVisible();

  await page.getByRole("button", { name: /nuovo account git/i }).click();
  await page.getByLabel("Nome").fill("Account Demo");
  await page.getByLabel("Provider").selectOption("github");
  // GitHub: username/email vuoti, solo il token (qui finto per l'ambiente e2e).
  await page.getByLabel("Token di accesso").fill("ghp_token_di_prova");
  await page.getByRole("button", { name: "Crea account" }).click();

  // Salvato: il form si chiude e l'account compare nella lista con il badge.
  await expect(page.getByText("Account Demo")).toBeVisible();
  await expect(page.getByText("GitHub")).toBeVisible();
});

// Creazione del progetto INTERAMENTE dalla UI tramite il wizard. Si sceglie
// l'account git (preselezionato, unico) e si attende che il wizard tenti di
// elencare i repository: con le credenziali finte dell'e2e quella chiamata
// fallisce (4xx dal provider), il wizard mostra l'errore e rivela il FALLBACK
// MANUALE (URL repository + branch a mano). Si completa la creazione da lì, così
// l'intero flusso resta nella UI senza dipendere da un provider git reale.
test("crea un progetto dal wizard (fallback manuale) e lo vede in lista", async () => {
  await page.getByRole("link", { name: /projects/i }).click();
  await expect(page.getByText("// nessun progetto collegato")).toBeVisible();
  await page.getByRole("link", { name: /nuovo progetto/i }).click();

  await expect(page.getByRole("heading", { name: "Nuovo progetto" })).toBeVisible();
  await page.getByLabel("Nome").fill("Demo Shop");
  // L'account "Account Demo" è preselezionato (unico). Il wizard tenta l'elenco
  // repo e, fallendo con le credenziali finte, scopre i campi manuali.
  const repoUrl = page.getByLabel("URL repository");
  await expect(repoUrl).toBeVisible();
  await repoUrl.fill("https://github.com/acme/demo-shop");
  const branch = page.getByLabel("Branch di default");
  await branch.fill("main");
  await page.getByRole("button", { name: "Crea progetto" }).click();

  // Sul 201 si atterra sul dettaglio del progetto.
  await expect(page).toHaveURL(/\/projects\/demo-shop$/);
  await expect(page.getByRole("heading", { name: "Demo Shop" })).toBeVisible();

  // E nella lista progetti il nuovo progetto è presente.
  await page.getByRole("link", { name: /projects/i }).click();
  await expect(page.getByRole("link", { name: /demo shop/i })).toBeVisible();
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
  // L'autore si verifica DENTRO il commento appena creato, non sulla pagina
  // intera (l'email dell'admin compare anche nel layout).
  const comment = page
    .getByRole("listitem")
    .filter({ hasText: "Indago io, sembra il gateway." });
  await expect(comment).toBeVisible();
  await expect(comment).toContainText(ADMIN_EMAIL);
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
