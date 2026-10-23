import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { currentReauthRequest, settleReauth } from "../../lib/reauth";
import { ReauthDialog } from "./reauth-dialog";

const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: startAuthenticationMock,
}));

vi.mock("qrcode", () => ({
  default: { toString: vi.fn(async () => "<svg></svg>") },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Risposte per (metodo, path); le chiamate non previste rispondono 500. */
type Route = (body: unknown) => Response;
let routes: Record<string, Route[]>;
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const key = `${init?.method ?? "GET"} ${String(input)}`;
  const queue = routes[key];
  const route = queue && (queue.length > 1 ? queue.shift() : queue[0]);
  if (!route) return jsonResponse(500, { message: `unexpected ${key}` });
  return route(init?.body ? JSON.parse(String(init.body)) : undefined);
});

function on(key: string, ...responses: Route[]) {
  routes[key] = responses;
}

function calls(key: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? "GET"} ${String(input)}` === key,
  );
}

const security =
  (passkeys: unknown[] = []) =>
  () =>
    jsonResponse(200, {
      totp: { configured: true, confirmedAt: "2026-10-01T00:00:00.000Z" },
      passkeys,
      backupCodesRemaining: 10,
      events: [],
    });

beforeEach(() => {
  routes = {};
  fetchMock.mockClear();
  startAuthenticationMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (currentReauthRequest()) settleReauth(false);
  vi.unstubAllGlobals();
});

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReauthDialog />
    </QueryClientProvider>,
  );
}

const reauthRequired = () =>
  jsonResponse(403, { code: "reauth_required", message: "Recent confirmation required" });

describe("ReauthDialog", () => {
  it("un 403 `reauth_required` apre il dialogo e, confermato col codice, la richiesta è ripetuta una volta", async () => {
    on("GET /api/me/security", security());
    on("POST /api/pats", reauthRequired, () => jsonResponse(201, { id: "p1" }));
    on("POST /api/me/security/reauth", () => new Response(null, { status: 204 }));
    renderDialog();

    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    await screen.findByRole("dialog");
    await userEvent.type(screen.getByLabelText(/authenticator code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await expect(result).resolves.toEqual({ id: "p1" });
    expect(calls("POST /api/me/security/reauth")[0]![1]?.body).toBe(
      JSON.stringify({ code: "123456" }),
    );
    expect(calls("POST /api/pats")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("annullato → l'errore originale arriva al chiamante", async () => {
    on("GET /api/me/security", security());
    on("DELETE /api/pats/p1", reauthRequired);
    renderDialog();

    // `catch` subito: il rifiuto arriva mentre il test sta ancora cliccando.
    const result = api.delete("/api/pats/p1").catch((cause: unknown) => cause);
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(await result).toMatchObject({ status: 403, code: "reauth_required" });
    expect(calls("DELETE /api/pats/p1")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("due richieste insieme → un dialogo", async () => {
    on("GET /api/me/security", security());
    on("POST /api/pats", reauthRequired, () => jsonResponse(201, { id: "p1" }));
    on("DELETE /api/pats/p2", reauthRequired, () => new Response(null, { status: 204 }));
    on("POST /api/me/security/reauth", () => new Response(null, { status: 204 }));
    renderDialog();

    const a = api.post("/api/pats", { name: "ci", expiresAt: null });
    const b = api.delete("/api/pats/p2");
    await waitFor(() => expect(calls("DELETE /api/pats/p2")).toHaveLength(1));
    expect(await screen.findAllByRole("dialog")).toHaveLength(1);
    await userEvent.type(screen.getByLabelText(/authenticator code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await expect(a).resolves.toEqual({ id: "p1" });
    await expect(b).resolves.toBeUndefined();
    expect(calls("POST /api/me/security/reauth")).toHaveLength(1);
  });

  it("un codice sbagliato resta nel dialogo con l'errore", async () => {
    on("GET /api/me/security", security());
    on("POST /api/pats", reauthRequired);
    on("POST /api/me/security/reauth", () =>
      jsonResponse(401, { code: "invalid_second_factor", message: "Invalid code" }),
    );
    renderDialog();

    void api.post("/api/pats", {}).catch(() => undefined);
    await screen.findByRole("dialog");
    await userEvent.type(screen.getByLabelText(/authenticator code/i), "000000");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(currentReauthRequest()).not.toBeNull();
  });

  it("offre la passkey solo a chi ne ha una, e la usa", async () => {
    on(
      "GET /api/me/security",
      security([
        { id: "k1", name: "Mac", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null },
      ]),
    );
    on("POST /api/pats", reauthRequired, () => jsonResponse(201, { id: "p1" }));
    on("POST /api/me/security/reauth/passkey/options", () =>
      jsonResponse(200, { challenge: "c", allowCredentials: [{ id: "x", type: "public-key" }] }),
    );
    on("POST /api/me/security/reauth/passkey/verify", () => new Response(null, { status: 204 }));
    startAuthenticationMock.mockResolvedValue({ id: "x", response: {} });
    renderDialog();

    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    await userEvent.click(await screen.findByRole("button", { name: /use a passkey/i }));

    await expect(result).resolves.toEqual({ id: "p1" });
    expect(calls("POST /api/me/security/reauth/passkey/verify")[0]![1]?.body).toBe(
      JSON.stringify({ response: { id: "x", response: {} } }),
    );
  });

  it("senza passkey il bottone non c'è; il codice di riserva sì", async () => {
    on("GET /api/me/security", security());
    on("POST /api/pats", reauthRequired);
    renderDialog();

    void api.post("/api/pats", {}).catch(() => undefined);
    await screen.findByRole("dialog");
    await waitFor(() => expect(calls("GET /api/me/security")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /use a passkey/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /use a backup code/i }));
    expect(screen.getByLabelText(/backup code/i)).toBeInTheDocument();
  });

  it("`second_factor_setup_required` mostra la configurazione, poi i codici di riserva, poi ripete", async () => {
    on(
      "POST /api/pats",
      () => jsonResponse(403, { code: "second_factor_setup_required", message: "Setup required" }),
      () => jsonResponse(201, { id: "p1" }),
    );
    on("POST /api/me/security/totp/setup", () =>
      jsonResponse(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x" }),
    );
    on("POST /api/me/security/totp/setup/confirm", () =>
      jsonResponse(200, { backupCodes: ["aaaa-bbbb", "cccc-dddd"] }),
    );
    renderDialog();

    const result = api.post("/api/pats", { name: "ci", expiresAt: null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    // Niente stato della sicurezza da leggere: chi configura non ha fattori.
    expect(calls("GET /api/me/security")).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(/authenticator code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    expect(calls("POST /api/pats")).toHaveLength(1);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await expect(result).resolves.toEqual({ id: "p1" });
    expect(calls("POST /api/pats")).toHaveLength(2);
  });

  it("chiuso dall'esterno (Escape) vale come annullato", async () => {
    on("GET /api/me/security", security());
    on("POST /api/pats", reauthRequired);
    renderDialog();

    const result = api.post("/api/pats", {}).catch((cause: unknown) => cause);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      dialog.focus();
    });
    await userEvent.keyboard("{Escape}");

    expect(await result).toMatchObject({ code: "reauth_required" });
  });
});
