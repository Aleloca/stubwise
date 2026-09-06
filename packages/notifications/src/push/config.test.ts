import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH_RELAY_URL, loadPushConfig } from "./config.js";

describe("loadPushConfig", () => {
  it("senza la chiave usa il relay pubblico: le push funzionano appena installi", () => {
    expect(loadPushConfig({})).toEqual({ relayUrl: DEFAULT_PUSH_RELAY_URL });
    expect(loadPushConfig({ PUSH_RELAY_URL: undefined })).toEqual({
      relayUrl: DEFAULT_PUSH_RELAY_URL,
    });
    expect(DEFAULT_PUSH_RELAY_URL).toBe("https://push.stubwise.aleloca.dev");
  });

  it("stringa VUOTA = push spente, ed è diverso da assente", () => {
    // È l'interruttore documentato: `PUSH_RELAY_URL=` in `.env` spegne le push
    // senza toccare né schema né immagini. Per questo il valore non passa da
    // `emptyAsUndefined` come le altre env del worker.
    expect(loadPushConfig({ PUSH_RELAY_URL: "" })).toBeNull();
    expect(loadPushConfig({ PUSH_RELAY_URL: "   " })).toBeNull();
  });

  it("accetta un relay https e ne toglie lo slash finale", () => {
    expect(loadPushConfig({ PUSH_RELAY_URL: "https://push.example" })).toEqual({
      relayUrl: "https://push.example",
    });
    expect(loadPushConfig({ PUSH_RELAY_URL: "https://push.example/" })).toEqual({
      relayUrl: "https://push.example",
    });
    expect(loadPushConfig({ PUSH_RELAY_URL: " https://push.example " })).toEqual({
      relayUrl: "https://push.example",
    });
  });

  it("un relay in chiaro fa FALLIRE l'avvio: il payload porta dati dell'utente", () => {
    // Titolo e corpo della notifica sono contenuto reale (titoli di ticket,
    // domande dell'agente). Su http viaggerebbero in chiaro verso un host
    // remoto. Fail-fast come `PULSE_TIMEZONE`: meglio un worker che non parte.
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "http://relay.example" })).toThrow(
      /PUSH_RELAY_URL/,
    );
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "ftp://relay.example" })).toThrow();
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "push.example" })).toThrow();
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "non un url" })).toThrow();
  });

  /** L'errore lanciato da `loadPushConfig`, per ispezionarne il messaggio. */
  function errorFor(url: string): Error {
    try {
      loadPushConfig({ PUSH_RELAY_URL: url });
    } catch (error) {
      return error as Error;
    }
    throw new Error(`atteso un errore per ${url}`);
  }

  it("il messaggio non ripete l'URL rifiutato: finisce nei log d'avvio", () => {
    // L'URL può contenere un host interno o credenziali in `user:pass@`.
    // Basta dire QUALE variabile è sbagliata.
    const error = errorFor("http://admin:segreto@relay.example");
    expect(error.message).not.toContain("segreto");
    expect(error.message).not.toContain("relay.example");
    expect(error.message).toContain("PUSH_RELAY_URL");
  });

  it("le credenziali nell'URL fanno fallire l'avvio, non cinque tentativi a vuoto", () => {
    // `new URL()` le accetta, ma `fetch` di Node lancia un TypeError che le
    // ripete per intero: il client lo leggerebbe come errore di rete, e a ogni
    // ritentativo la password finirebbe come `cause` nel log del poller.
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "https://user:pw@relay.example" })).toThrow(
      /credenziali/,
    );
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "https://user@relay.example" })).toThrow(
      /credenziali/,
    );
  });

  it("query e frammento fanno fallire l'avvio: l'endpoint si compone per concatenazione", () => {
    // `https://relay.example/?x=1` diventerebbe `…/?x=1/v1/send`: un 404 a ogni
    // consegna, cioè PushRelayRejected e tutte le push `failed` senza retry.
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "https://relay.example/?x=1" })).toThrow(
      /query/,
    );
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "https://relay.example/#frag" })).toThrow(
      /frammento/,
    );
  });

  it("un path di base resta lecito: il relay può stare dietro un prefisso", () => {
    expect(loadPushConfig({ PUSH_RELAY_URL: "https://api.example/push" })).toEqual({
      relayUrl: "https://api.example/push",
    });
  });

  it("il loopback in chiaro è ammesso: serve ai test e non attraversa la rete", () => {
    for (const url of ["http://localhost:9999", "http://127.0.0.1:8090", "http://[::1]:8090"]) {
      expect(loadPushConfig({ PUSH_RELAY_URL: url })).toEqual({ relayUrl: url });
    }
  });

  it("un host che COMINCIA per localhost non è il loopback", () => {
    // `http://localhost.evil.example` supera un controllo scritto come
    // `startsWith("http://localhost")` ed è un host remoto a tutti gli effetti:
    // il confronto è sull'hostname, non sul prefisso della stringa.
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "http://localhost.evil.example" })).toThrow();
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "http://localhost@evil.example" })).toThrow();
    expect(() => loadPushConfig({ PUSH_RELAY_URL: "http://127.0.0.1.evil.example" })).toThrow();
  });
});
