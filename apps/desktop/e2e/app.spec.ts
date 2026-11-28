import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { clientIpHeaders, nextTotpCode, signInWithRequest } from "./second-factor";
import { seedMailThread, type SeededThread } from "./seed";

/*
 * La suite E2E MINIMA della nuova app, da avere prima di spegnere il web
 * vecchio (D3 del piano del taglio): la build web vera su `/app`, lo stack
 * vero. Il percorso di una persona: entra con password e secondo fattore,
 * vede la Home, apre una task e la commenta, legge un thread della posta.
 *
 * I dati li prepara lo spec, senza il web vecchio: il primo admin e il suo
 * secondo fattore via API, un progetto e una task via API, la posta nel
 * database (`seed.ts`). Nessuna attesa a tempo: ogni passo aspetta uno stato
 * della pagina.
 */

const ADMIN_EMAIL = "ada@example.com";
const ADMIN_PASSWORD = "password-sicura-e2e-app";
const PROJECT_CODE = "ESHOP";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let taskCode: string;
let thread: SeededThread;

async function prepare(request: APIRequestContext): Promise<void> {
  const status = await request.get("/api/auth/setup");
  const { needed } = (await status.json()) as { needed: boolean };
  if (needed) {
    const setup = await request.post("/api/auth/setup", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(setup.ok()).toBe(true);
  }
  // Il primo login configura il secondo fattore (via API); da qui ogni login lo chiede.
  await signInWithRequest(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const me = (await (await request.get("/api/auth/me")).json()) as { user: { id: string } };

  const project = await request.post("/api/projects", { data: { name: "E-shop", code: PROJECT_CODE } });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  const task = await request.post("/api/tasks", { data: { projectId, title: "Controlla il pagamento del checkout", type: "bug" } });
  expect(task.status(), await task.text()).toBe(201);
  taskCode = ((await task.json()) as { code: string }).code;

  thread = await seedMailThread(me.user.id, ADMIN_EMAIL);
  // La preparazione non lascia una sessione: il login vero lo fa la UI.
  await request.post("/api/auth/logout");
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext(clientIpHeaders());
  page = await context.newPage();
  await prepare(context.request);
});

test.afterAll(async () => {
  await context.close();
});

test("si entra dalla UI con password e codice dell'app, e si arriva alla Home", async () => {
  await page.goto("/app/");
  await expect(page.getByRole("heading", { name: "Sign in to Stubwise" })).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  // Il campo si invia da sé alla sesta cifra (`SecondFactorStep`): niente clic su «Verify».
  await page.getByLabel("Code").fill(await nextTotpCode(ADMIN_EMAIL));

  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
});

test("una task si apre dal suo progetto, e un commento resta dopo un ricaricamento", async () => {
  await page.goto(`/app/#/p/${PROJECT_CODE}/tasks?task=${taskCode}`);
  // A 1440 px il pannello è affiancato (`DOCKED_PANEL_QUERY`): una regione della pagina, non un dialogo.
  const panel = page.getByRole("region", { name: `Task ${taskCode}` });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Controlla il pagamento del checkout")).toBeVisible();

  const comment = "Riprodotto su Safari: manca il token del 3-D Secure.";
  await panel.getByRole("textbox", { name: "Write a comment" }).fill(comment);
  // Il commento compare subito (ottimistico): prima di ricaricare si aspetta che il server l'abbia salvato.
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && /\/comments(\?|$)/.test(new URL(r.url()).pathname + "?"));
  await panel.getByRole("button", { name: "Comment" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(panel.getByText(comment)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: `Task ${taskCode}` }).getByText(comment)).toBeVisible();
});

test("la Posta: un thread si apre e se ne legge il messaggio", async () => {
  await page.goto("/app/#/mail");
  await expect(page.getByRole("heading", { level: 1, name: "Mail" })).toBeVisible();
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  await conversations.getByRole("option", { name: new RegExp(thread.subject) }).click();
  // Il messaggio nel riquadro di lettura, non l'anteprima nell'elenco.
  const pane = page.locator("[data-reading-pane]");
  await expect(pane.getByText(thread.body)).toBeVisible();
  await expect(pane.getByText(thread.from)).toBeVisible();
});
