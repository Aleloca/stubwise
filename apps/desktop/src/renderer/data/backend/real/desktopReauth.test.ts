import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { auth, me } from "./session";

// La riconferma dalla build app desktop (decisione del maintainer, 10 nov
// 2026): il codice va su `POST /api/auth/desktop-reauth` (la riconferma del
// PAT), mai su quella della sessione; niente passkey dal desktop.

type Req = Parameters<NonNullable<NonNullable<Window["stubwise"]>["api"]>["request"]>[0];

function withBridge(reply: (req: Req) => { status: number; body?: unknown }) {
  const request = vi.fn(async (req: Req) => {
    const r = reply(req);
    return {
      status: r.status,
      headers: { "content-type": "application/json" },
      body: r.body === undefined ? "" : JSON.stringify(r.body),
    };
  });
  window.stubwise = { platform: "darwin", api: { request } };
  return request;
}

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  delete window.stubwise;
  setAppClientForTests(null);
});

describe("riconferma nell'app desktop", () => {
  it("il codice va su /api/auth/desktop-reauth, non sulla riconferma della sessione", async () => {
    const request = withBridge(() => ({ status: 204 }));
    expect(await auth.reauthenticate({ method: "totp", code: " 123456 " })).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0]![0];
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/api/auth/desktop-reauth");
    expect(JSON.parse(String(sent.body))).toEqual({ code: "123456" });
  });

  it("un codice sbagliato è la frase di sempre; il blocco anche", async () => {
    withBridge(() => ({ status: 401, body: { code: "invalid_second_factor", message: "x" } }));
    expect(await auth.reauthenticate({ method: "backup_code", code: "abcd" })).toMatchObject({ ok: false, error: "invalid_code" });
    setAppClientForTests(null);
    withBridge(() => ({ status: 423, body: { code: "second_factor_locked", message: "x", lockedUntil: "2026-11-10T12:00:00.000Z" } }));
    expect(await auth.reauthenticate({ method: "totp", code: "000000" })).toEqual({
      ok: false,
      error: "locked",
      lockedUntil: "2026-11-10T12:00:00.000Z",
    });
  });

  it("niente passkey dal desktop: il dialogo non la offre, e nessuna chiamata parte", async () => {
    const request = withBridge((req) =>
      req.path === "/api/me/security"
        ? { status: 200, body: { totp: { configured: true }, passkeys: [{ id: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01", name: "Mac", createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null }], backupCodesRemaining: 8 } }
        : { status: 500 },
    );
    const security = (await me.getMySecurity()) as unknown as { passkeys: unknown[] };
    expect(security.passkeys).toEqual([]);
    request.mockClear();
    expect(await auth.reauthenticate({ method: "passkey" } as never)).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
  });
});
