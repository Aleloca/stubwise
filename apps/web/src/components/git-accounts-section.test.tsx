import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import type { GitAccount, SessionUser } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { GitAccountsSection } from "./git-accounts-section";

/**
 * Sezione "Account Git" delle impostazioni (solo admin): lista degli account,
 * creazione (POST), validazione (render dei check) ed eliminazione (409 inline).
 * La rete è mockata via `fetch` globale (come settings.test): le queryOptions
 * catturano i fetcher all'import, quindi spiare il modulo non basterebbe.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

type Handler = (url: URL, init?: RequestInit) => Response;

function meHandler(role: "admin" | "member"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
}

/** La sezione sta sotto una pagina solo admin: l'utente è admin salvo override. */
function mockApi(handlers: Record<string, Handler>) {
  const all: Record<string, Handler> = { "GET /api/auth/me": meHandler("admin"), ...handlers };
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = all[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

function makeAccount(overrides: Partial<GitAccount> = {}): GitAccount {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Account Demo",
    provider: "github",
    workspace: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderSection(opts: { me?: "admin" | "member" } = {}): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Pre-seminato: il ruolo è GIÀ noto al primo render, quindi l'assenza del
  // toggle non può essere «/me non è ancora arrivato».
  if (opts.me) {
    queryClient.setQueryData(meQueryOptions.queryKey, {
      user: { id: "u1", email: "ada@example.com", role: opts.me, language: "en", avatarUrl: null, slackUserId: null } satisfies SessionUser,
    });
  }
  render(
    <QueryClientProvider client={queryClient}>
      <GitAccountsSection />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("GitAccountsSection — lista", () => {
  it("mostra gli account con nome, provider e data di creazione", async () => {
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [
          makeAccount(),
          makeAccount({
            id: "22222222-2222-4222-8222-222222222222",
            name: "Bitbucket Prod",
            provider: "bitbucket",
          }),
        ]),
    });

    renderSection();

    expect(await screen.findByText("Account Demo")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket Prod")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
  });

  it("senza account mostra il vuoto", async () => {
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, []) });
    renderSection();
    expect(await screen.findByText(/no git accounts/i)).toBeInTheDocument();
  });
});

describe("GitAccountsSection — creazione", () => {
  it("il form invia il POST col payload giusto", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, []),
      "POST /api/git-accounts": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makeAccount());
      },
    });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /new git account/i }));

    await user.type(screen.getByLabelText("Name"), "Account Demo");
    await user.selectOptions(screen.getByLabelText("Provider"), "bitbucket");
    await user.type(screen.getByLabelText("Workspace"), "mio-workspace");
    await user.type(screen.getByLabelText("Username"), "acme-bot");
    await user.type(screen.getByLabelText("Email"), "bot@acme.io");
    await user.type(screen.getByLabelText("Access token"), "api-token");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(postBody).toEqual({
        name: "Account Demo",
        provider: "bitbucket",
        credentials: { username: "acme-bot", email: "bot@acme.io", token: "api-token" },
        workspace: "mio-workspace",
      }),
    );
  });

  it("il campo Workspace è mostrato solo per Bitbucket, non per GitHub", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, []) });

    renderSection();

    await user.click(await screen.findByRole("button", { name: /new git account/i }));

    // Default provider = Bitbucket: il campo Workspace c'è.
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();

    // Passando a GitHub il campo sparisce.
    await user.selectOptions(screen.getByLabelText("Provider"), "github");
    expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  });
});

describe("GitAccountsSection — validazione", () => {
  it("clic su Valida mostra i check ✓/✗ con dettaglio", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      "POST /api/git-accounts/11111111-1111-4111-8111-111111111111/validate": () =>
        jsonResponse(200, {
          ok: false,
          checks: [
            { name: "Accesso git (push)", ok: true, detail: "autenticazione git e push ok" },
            { name: "Accesso REST API (PR)", ok: false, detail: "401: serve l'email" },
          ],
        }),
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Validate" }));

    expect(await screen.findByText("Issues detected")).toBeInTheDocument();
    expect(screen.getByText(/autenticazione git e push ok/)).toBeInTheDocument();
    expect(screen.getByText(/serve l'email/)).toBeInTheDocument();
  });

  it("i check in più (scope del token) si disegnano nella stessa lista", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      "POST /api/git-accounts/11111111-1111-4111-8111-111111111111/validate": () =>
        jsonResponse(200, {
          ok: false,
          checks: [
            { name: "Autenticazione", ok: true, detail: "token valido" },
            { name: "Repository", ok: true, detail: "lettura ok" },
            { name: "Scope del token", ok: true, detail: "scope del revisore presenti" },
            { name: "Scope webhook", ok: false, detail: "manca write:webhook:bitbucket" },
          ],
        }),
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Validate" }));

    expect(await screen.findByText(/manca write:webhook:bitbucket/)).toBeInTheDocument();
    for (const detail of [/token valido/, /lettura ok/, /scope del revisore presenti/]) {
      expect(screen.getByText(detail)).toBeInTheDocument();
    }
  });
});

describe("GitAccountsSection — eliminazione", () => {
  it("su 409 mostra il messaggio 'account usato' inline", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      "DELETE /api/git-accounts/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(409, { message: "Account git in uso da uno o più progetti" }),
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText(/used by one or more projects/i)).toBeInTheDocument();
  });

  it("elimina con conferma quando non è in uso", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, deleted ? [] : [makeAccount()]),
      "DELETE /api/git-accounts/11111111-1111-4111-8111-111111111111": () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    renderSection();

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByText("Account Demo")).not.toBeInTheDocument());
  });
});

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PUT_PATH = `PUT /api/git-accounts/${ACCOUNT_ID}/default-reviewer`;

/**
 * Il toggle di un account. ASINCRONO: compare solo quando la query di `/me`
 * (separata da quella degli account) ha detto che l'utente è admin, quindi
 * cercarlo in modo sincrono subito dopo il nome dell'account è una corsa.
 */
async function toggleOf(name: string): Promise<HTMLInputElement> {
  const row = (await screen.findByText(name)).closest("li") as HTMLElement;
  return within(row).findByRole<HTMLInputElement>("checkbox", { name: "Default reviewer" });
}

describe("GitAccountsSection — revisore predefinito", () => {
  it("fixture SENZA `isDefaultReviewer`: il toggle è spento", async () => {
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]) });
    expect("isDefaultReviewer" in makeAccount()).toBe(false);

    renderSection();

    await screen.findByText("Account Demo");
    expect(await toggleOf("Account Demo")).not.toBeChecked();
  });

  it("accenderlo chiama il PUT e mostra l'esito con gli avvisi per repository", async () => {
    const user = userEvent.setup();
    let put = 0;
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [makeAccount({ isDefaultReviewer: put > 0 })]),
      [PUT_PATH]: () => {
        put++;
        return jsonResponse(200, {
          account: makeAccount({ isDefaultReviewer: true }),
          replaced: null,
          warnings: [
            { repositoryId: "r1", repositoryName: "shop-api", code: "default_is_main" },
            { repositoryId: "r2", repositoryName: "shop-web", code: "review_account_no_write_permission" },
            { repositoryId: "r3", repositoryName: "shop-ops", code: "codice_nuovo_del_server" },
          ],
        });
      },
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    expect(await screen.findByText(en.settings.gitAccounts.defaultReviewerSet)).toBeInTheDocument();
    expect(put).toBe(1);
    const list = screen.getByRole("list", { name: en.settings.gitAccounts.defaultReviewerWarningsTitle });
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      `shop-api: ${en.settings.gitAccounts.defaultReviewerWarning.default_is_main}`,
      `shop-web: ${en.errors.review_account_no_write_permission}`,
      "shop-ops: check failed (codice_nuovo_del_server)",
    ]);
    // Dice cosa succede DAVVERO: la review prova comunque, e il ripiego è
    // il commento del principale con «Verdict not submitted».
    const consequence = screen.getByText(en.settings.gitAccounts.defaultReviewerWarningsConsequence);
    expect(consequence.textContent).toContain("Verdict not submitted");
    expect(screen.queryByText(/won't review/)).not.toBeInTheDocument();
    await waitFor(async () => expect(await toggleOf("Account Demo")).toBeChecked());
  });

  it("solo `default_is_main`: nessuna frase sul ripiego — lì il predefinito non si applica", async () => {
    const user = userEvent.setup();
    let put = 0;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount({ isDefaultReviewer: put > 0 })]),
      [PUT_PATH]: () => {
        put++;
        return jsonResponse(200, {
          account: makeAccount({ isDefaultReviewer: true }),
          replaced: null,
          warnings: [{ repositoryId: "r1", repositoryName: "shop-api", code: "default_is_main" }],
        });
      },
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    expect(
      await screen.findByRole("list", { name: en.settings.gitAccounts.defaultReviewerWarningsTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByText(en.settings.gitAccounts.defaultReviewerWarningsConsequence)).not.toBeInTheDocument();
  });

  it("risposta SENZA `replaced` né `warnings`: l'esito si mostra, nessuna eccezione", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      // Solo `account`: i due campi mancanti arrivano al ramo che li legge.
      [PUT_PATH]: () => jsonResponse(200, { account: makeAccount({ isDefaultReviewer: true }) }),
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    expect(await screen.findByText(en.settings.gitAccounts.defaultReviewerSet)).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: en.settings.gitAccounts.defaultReviewerWarningsTitle }),
    ).not.toBeInTheDocument();
  });

  it("un altro predefinito nello stesso ambito: prima chiede conferma, poi dice chi ha sostituito", async () => {
    const user = userEvent.setup();
    let put = 0;
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [
          makeAccount({ provider: "bitbucket", workspace: "acme" }),
          makeAccount({ id: OTHER_ID, name: "Vecchio Bot", provider: "bitbucket", workspace: "acme", isDefaultReviewer: true }),
        ]),
      [PUT_PATH]: () => {
        put++;
        return jsonResponse(200, {
          account: makeAccount({ provider: "bitbucket", workspace: "acme", isDefaultReviewer: true }),
          replaced: { id: OTHER_ID, name: "Vecchio Bot" },
          warnings: [],
        });
      },
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    expect(screen.getByText("This replaces Vecchio Bot as the default reviewer.")).toBeInTheDocument();
    expect(put).toBe(0);
    const row = screen.getByText("Account Demo").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Replace" }));

    expect(await screen.findByText("Now the default reviewer, in place of Vecchio Bot.")).toBeInTheDocument();
    expect(put).toBe(1);
  });

  it("un predefinito di un ALTRO workspace non chiede conferma", async () => {
    const user = userEvent.setup();
    let put = 0;
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [
          makeAccount({ provider: "bitbucket", workspace: "acme" }),
          makeAccount({ id: OTHER_ID, name: "Altro Bot", provider: "bitbucket", workspace: "altro", isDefaultReviewer: true }),
        ]),
      [PUT_PATH]: () => {
        put++;
        return jsonResponse(200, { account: makeAccount({ isDefaultReviewer: true }), replaced: null, warnings: [] });
      },
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    await waitFor(() => expect(put).toBe(1));
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
  });

  it("spegnerlo chiama il DELETE", async () => {
    const user = userEvent.setup();
    let deleted = 0;
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount({ isDefaultReviewer: deleted === 0 })]),
      [`DELETE /api/git-accounts/${ACCOUNT_ID}/default-reviewer`]: () => {
        deleted++;
        return jsonResponse(204, null);
      },
    });

    renderSection();
    await screen.findByText("Account Demo");
    expect(await toggleOf("Account Demo")).toBeChecked();
    await user.click(await toggleOf("Account Demo"));

    expect(await screen.findByText(en.settings.gitAccounts.defaultReviewerRemoved)).toBeInTheDocument();
    expect(deleted).toBe(1);
    await waitFor(async () => expect(await toggleOf("Account Demo")).not.toBeChecked());
  });

  // Ogni `code` del PUT ha un testo proprio: il `message` del server è diverso
  // apposta, così l'asserzione prova la traduzione e non l'eco del message.
  const ERRORS = [
    [409, "default_reviewer_conflict"],
    [422, "default_reviewer_workspace_missing"],
    [422, "review_account_identity_unresolved"],
    [400, "credentials_undecryptable"],
  ] as const;

  it.each(ERRORS)("errore %i %s: il suo testo, e il toggle resta spento", async (status, code) => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      [PUT_PATH]: () => jsonResponse(status, { message: "server message", code }),
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.errors[code]);
    expect(alert).not.toHaveTextContent("server message");
    expect(await toggleOf("Account Demo")).not.toBeChecked();
  });

  it("422 default_reviewer_invalid porta il dettaglio dei check falliti", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      [PUT_PATH]: () =>
        jsonResponse(422, {
          message: "Scope del token: manca write:pullrequest:bitbucket",
          code: "default_reviewer_invalid",
        }),
    });

    renderSection();
    await screen.findByText("Account Demo");
    await user.click(await toggleOf("Account Demo"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The account failed the checks a reviewer needs. Scope del token: manca write:pullrequest:bitbucket",
    );
  });

  it("un member non vede il toggle", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount({ isDefaultReviewer: true })]),
    });

    // Il ruolo è pre-seminato: al primo render è già «member», quindi l'assenza
    // del toggle la decide la guardia, non un `/me` ancora in volo.
    const queryClient = renderSection({ me: "member" });
    await screen.findByText("Account Demo");
    expect(queryClient.getQueryState(meQueryOptions.queryKey)?.status).toBe("success");
    expect(screen.queryByRole("checkbox", { name: "Default reviewer" })).not.toBeInTheDocument();
  });

  it("l'hint del toggle dice l'eccezione: non dove è l'account principale", async () => {
    mockApi({ "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]) });
    renderSection();

    expect(await toggleOf("Account Demo")).toHaveAccessibleDescription(
      en.settings.gitAccounts.defaultReviewerHint,
    );
    expect(en.settings.gitAccounts.defaultReviewerHint).toMatch(/where it is the main account/);
  });

  // Il revisore delle repository è DERIVATO dal server (D8): cambiare il
  // predefinito, o l'account che lo è, lo cambia. La cache dei repository
  // (`staleTime` 60 s) va invalidata, o un admin legge ancora il vecchio.
  const REPO_DETAIL_KEY = ["repositories", "detail", "demo-shop"];
  const REPO_LIST_KEY = ["repositories", null];
  function seedRepositories(queryClient: QueryClient) {
    queryClient.setQueryData(REPO_DETAIL_KEY, { slug: "demo-shop" });
    queryClient.setQueryData(REPO_LIST_KEY, [{ slug: "demo-shop" }]);
  }
  function repositoriesInvalidated(queryClient: QueryClient): boolean {
    return (
      queryClient.getQueryState(REPO_DETAIL_KEY)?.isInvalidated === true &&
      queryClient.getQueryState(REPO_LIST_KEY)?.isInvalidated === true
    );
  }

  it("dopo il PUT la cache dei repository è invalidata", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount()]),
      [PUT_PATH]: () => jsonResponse(200, { account: makeAccount({ isDefaultReviewer: true }), replaced: null, warnings: [] }),
    });
    const queryClient = renderSection();
    seedRepositories(queryClient);
    expect(repositoriesInvalidated(queryClient)).toBe(false);

    await user.click(await toggleOf("Account Demo"));

    await screen.findByText(en.settings.gitAccounts.defaultReviewerSet);
    await waitFor(() => expect(repositoriesInvalidated(queryClient)).toBe(true));
  });

  it("dopo il DELETE la cache dei repository è invalidata", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount({ isDefaultReviewer: true })]),
      [`DELETE /api/git-accounts/${ACCOUNT_ID}/default-reviewer`]: () => jsonResponse(204, null),
    });
    const queryClient = renderSection();
    seedRepositories(queryClient);

    await user.click(await toggleOf("Account Demo"));

    await screen.findByText(en.settings.gitAccounts.defaultReviewerRemoved);
    await waitFor(() => expect(repositoriesInvalidated(queryClient)).toBe(true));
  });

  it("dopo il PATCH di un account la cache dei repository è invalidata", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () => jsonResponse(200, [makeAccount({ isDefaultReviewer: true })]),
      [`PATCH /api/git-accounts/${ACCOUNT_ID}`]: () => jsonResponse(200, makeAccount({ name: "Rinominato" })),
    });
    const queryClient = renderSection();
    seedRepositories(queryClient);

    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    await user.click(within(row).getByRole("button", { name: "Save account" }));

    await waitFor(() => expect(repositoriesInvalidated(queryClient)).toBe(true));
  });

  it("conferma pendente e il predefinito da sostituire sparisce dopo un refetch: il toggle non resta bloccato", async () => {
    const user = userEvent.setup();
    let otherIsDefault = true;
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [
          makeAccount(),
          makeAccount({ id: OTHER_ID, name: "Vecchio Bot", isDefaultReviewer: otherIsDefault }),
        ]),
    });
    const queryClient = renderSection();
    await user.click(await toggleOf("Account Demo"));
    expect(screen.getByText("This replaces Vecchio Bot as the default reviewer.")).toBeInTheDocument();
    expect(await toggleOf("Account Demo")).toBeDisabled();

    // Un altro admin ha spento il vecchio predefinito: il refetch lo toglie.
    otherIsDefault = false;
    await queryClient.invalidateQueries({ queryKey: ["git-accounts"] });

    await waitFor(() =>
      expect(screen.queryByText("This replaces Vecchio Bot as the default reviewer.")).not.toBeInTheDocument(),
    );
    expect(await toggleOf("Account Demo")).toBeEnabled();
  });

  it("PATCH del workspace su un predefinito: 409 col suo testo", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/git-accounts": () =>
        jsonResponse(200, [makeAccount({ provider: "bitbucket", workspace: "acme", isDefaultReviewer: true })]),
      [`PATCH /api/git-accounts/${ACCOUNT_ID}`]: () =>
        jsonResponse(409, { message: "server message", code: "default_reviewer_workspace_locked" }),
    });

    renderSection();
    const row = (await screen.findByText("Account Demo")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const workspace = within(row).getByLabelText("Workspace");
    await user.clear(workspace);
    await user.type(workspace, "altro");
    await user.click(within(row).getByRole("button", { name: "Save account" }));

    const alert = await within(row).findByRole("alert");
    expect(alert).toHaveTextContent(en.errors.default_reviewer_workspace_locked);
    expect(alert).not.toHaveTextContent("server message");
  });
});
