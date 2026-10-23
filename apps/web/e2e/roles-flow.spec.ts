import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * Ruoli e membri contro lo stack reale (22 ott 2026): un admin crea un ruolo
 * di progetto dalla pagina Ruoli, lo assegna a un utente nei Membri di UN
 * progetto, e quell'utente vede solo quel progetto.
 *
 * Lo stack è condiviso con `core-flows.spec.ts` nella stessa run (un solo
 * webServer, un solo database): questo spec non presuppone un database vuoto.
 * Se l'istanza è vergine fa il primo setup, altrimenti entra con l'admin che
 * `core-flows` ha creato (stesse credenziali). Nomi con un suffisso unico, così
 * una seconda run sullo stesso stack non collide.
 */

const ADMIN_EMAIL = "ada@example.com";
const ADMIN_PASSWORD = "password-sicura-e2e";
const USER_PASSWORD = "password-sicura-e2e-utente";

test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const roleName = `Reader ${suffix}`;
const visibleProject = `Roles Alpha ${suffix}`;
const hiddenProject = `Roles Beta ${suffix}`;
const userEmail = `reader-${suffix}@example.com`;

let page: Page;
let visibleProjectId: string;
let hiddenProjectId: string;

/** Entra come admin: primo setup se l'istanza è vergine, login altrimenti. */
async function signInAdmin(request: APIRequestContext): Promise<void> {
  const status = await request.get("/api/auth/setup");
  const { needed } = (await status.json()) as { needed: boolean };
  if (needed) {
    const setup = await request.post("/api/auth/setup", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(setup.ok()).toBe(true);
  }
  const login = await request.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
}

async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/projects", { data: { name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // `page.request` condivide i cookie della pagina: la sessione vale per entrambi.
  await signInAdmin(page.request);
  visibleProjectId = await createProject(page.request, visibleProject);
  hiddenProjectId = await createProject(page.request, hiddenProject);

  // L'utente: invito e registrazione via API, da un contesto SENZA la sessione
  // dell'admin (la registrazione apre la sessione del nuovo utente).
  const invite = await page.request.post("/api/auth/invites", { data: { email: userEmail } });
  expect(invite.status()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const anonymous = await browser.newContext();
  const registered = await anonymous.request.post("/api/auth/register", {
    data: { token, email: userEmail, password: USER_PASSWORD },
  });
  expect(registered.ok()).toBe(true);
  await anonymous.close();
});

test.afterAll(async () => {
  await page.close();
});

test("Impostazioni → Ruoli: crea un ruolo di progetto con i permessi scelti", async () => {
  await page.goto("/settings/roles");
  const projectRoles = page.getByRole("region", { name: "Project roles" });
  await expect(projectRoles.getByText("Project Lead")).toBeVisible();

  await projectRoles.getByRole("button", { name: "+ New project role" }).click();
  await projectRoles.getByLabel("Name").fill(roleName);
  await projectRoles.getByLabel("View docs").check();
  await projectRoles.getByLabel("Create tickets").check();
  await projectRoles.getByRole("button", { name: "Save role" }).click();

  const row = projectRoles.getByRole("listitem", { name: roleName });
  await expect(row).toBeVisible();
  await expect(row.getByText(/2 permissions · 0 memberships/)).toBeVisible();
});

test("Membri del progetto: assegna il ruolo all'utente in UN progetto", async () => {
  await page.goto(`/projects/${visibleProjectId}`);
  const members = page.getByRole("region", { name: "Members" });
  const form = members.getByRole("form", { name: "Add a member" });
  await form.getByLabel("User").selectOption({ label: userEmail });
  await form.getByLabel("Role").selectOption({ label: roleName });
  await form.getByRole("button", { name: "Add member" }).click();

  const row = members.getByRole("listitem", { name: userEmail });
  await expect(row).toBeVisible();
  await expect(row.getByRole("combobox")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(row.getByRole("combobox").locator("option:checked")).toHaveText(roleName);
});

test("l'utente vede solo il progetto in cui è membro", async ({ browser }) => {
  const context = await browser.newContext();
  const userPage = await context.newPage();
  await userPage.goto("/login");
  await userPage.getByLabel("Email").fill(userEmail);
  await userPage.getByLabel("Password").fill(USER_PASSWORD);
  await userPage.getByRole("button", { name: "Sign in" }).click();
  await expect(userPage).not.toHaveURL(/\/login$/);

  await userPage.goto("/projects");
  await expect(userPage.getByText(visibleProject)).toBeVisible();
  await expect(userPage.getByText(hiddenProject)).toHaveCount(0);

  // Il dettaglio di un progetto non suo non esiste per lui (404, non 403).
  expect((await userPage.request.get(`/api/projects/${visibleProjectId}`)).status()).toBe(200);
  expect((await userPage.request.get(`/api/projects/${hiddenProjectId}`)).status()).toBe(404);
  await context.close();
});
