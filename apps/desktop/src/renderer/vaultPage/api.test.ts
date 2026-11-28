import { describe, expect, it, vi } from "vitest";
import { loadMe, who } from "./api";

// Chi guarda nella pagina a sé (I-2): `/api/auth/me`, senza il livello dati
// dell'app; una sessione parziale o assente è `null` (→ il login dell'app).

const response = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("loadMe", () => {
  it("una sessione completa: chi è, e se è full admin", async () => {
    const fetcher = vi.fn(async () => response(200, { user: { id: "p-ada", email: "ada@example.com" }, instancePermissions: ["instance.full_admin"] }));
    expect(await loadMe(fetcher as never)).toEqual({ id: "p-ada", email: "ada@example.com", fullAdmin: true });
    expect(fetcher).toHaveBeenCalledWith("/api/auth/me", { credentials: "same-origin" });
    expect(who().personId).toBe("p-ada");
  });

  it("401 (nessuna sessione) e 403 (secondo fattore da dare): `null`", async () => {
    expect(await loadMe((async () => response(401, { code: "unauthenticated" })) as never)).toBeNull();
    expect(await loadMe((async () => response(403, { code: "second_factor_required" })) as never)).toBeNull();
    expect(who().personId).toBeNull();
  });

  it("un'altra persona cambia l'etichetta di sessione (il worker chiude)", async () => {
    await loadMe((async () => response(200, { user: { id: "p-ada", email: "a@x" } })) as never);
    const first = who().sessionTag;
    await loadMe((async () => response(200, { user: { id: "p-bea", email: "b@x" } })) as never);
    expect(who().sessionTag).not.toBe(first);
  });
});
