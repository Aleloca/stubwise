import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Test degli endpoint `me` che il CLIENT costruisce da sé: url, metodo e
 * corpo. Non c'è un server dietro — `fetch` è finto — e non è una lacuna: qui
 * si sorveglia esattamente ciò che i test del server NON possono vedere,
 * perché quelli iniettano il payload già pronto e saltano il client.
 *
 * È il posto in cui la codifica sbagliata di un token push verrebbe
 * reintrodotta, quindi è il posto in cui va sorvegliata.
 */
function clientSenzaRisposta() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  const client = createStubwiseClient({
    baseUrl: "",
    getAuthHeader: () => null,
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

/** Ultima chiamata a fetch: url, metodo e corpo grezzo. */
function lastCall(fetchImpl: ReturnType<typeof clientSenzaRisposta>["fetchImpl"]) {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return { url: String(url), method: String(init!.method), body: init!.body };
}

describe("endpoints me: device push", () => {
  it("registerDevice: PUT su /api/me/devices col device nel corpo", async () => {
    const { client, fetchImpl } = clientSenzaRisposta();
    await client.me.registerDevice({ platform: "ios", token: "tok-1", appVersion: "1.2.3" });
    const call = lastCall(fetchImpl);
    expect([call.url, call.method]).toEqual(["/api/me/devices", "PUT"]);
    expect(call.body).toBe(JSON.stringify({ platform: "ios", token: "tok-1", appVersion: "1.2.3" }));
  });

  it("deleteDevice: POST su /api/me/devices/delete, mai un DELETE col token nel path", async () => {
    // Il path è FISSO e non contiene il token. Se un giorno tornasse un
    // `DELETE /api/me/devices/:token`, l'url qui sotto conterrebbe il token e
    // questo confronto fallirebbe: è la guardia contro il ritorno della fuga
    // nei log (il server logga `req.url`, non il corpo).
    const { client, fetchImpl } = clientSenzaRisposta();
    await client.me.deleteDevice("tok-1");
    const call = lastCall(fetchImpl);
    expect([call.url, call.method]).toEqual(["/api/me/devices/delete", "POST"]);
    expect(call.url).not.toContain("tok-1");
  });

  it("deleteDevice: il token viaggia GREZZO, senza percent-encoding", async () => {
    // La guardia che il test del server non può fare. Un `encodeURIComponent`
    // rimesso "per sicurezza" qui trasformerebbe `abc/def:ghi` in
    // `abc%2Fdef%3Aghi`: il server cercherebbe una riga con QUEL token, non ne
    // troverebbe nessuna e risponderebbe 204 — una cancellazione che non
    // cancella, silenziosa, e un telefono che continua a ricevere push dopo il
    // logout.
    const { client, fetchImpl } = clientSenzaRisposta();
    const token = "abc/def:ghi_jkl-mno";
    await client.me.deleteDevice(token);
    const call = lastCall(fetchImpl);
    expect(call.body).toBe(JSON.stringify({ token }));
    expect(String(call.body)).toContain("abc/def:ghi");
    expect(String(call.body)).not.toContain("%2F");
  });
});
