import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, servers, setLatency } from "../api";
import { setSessionPersonId } from "../session";

// Area 8, F4b (R3): la chiave pubblica d'istanza che verifica i comandi
// dell'agente (`GET /api/servers/command-key`, `monitor.manage`). Va nel
// comando d'installazione con le operazioni accese: l'agente la fissa e
// non la scarica mai dal server.

const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("la chiave dei comandi (R3)", () => {
  it("chi gestisce il monitor la legge: una chiave pubblica ed25519, sempre la stessa", async () => {
    setSessionPersonId("p-roberta");
    const { publicKey } = await servers.getCommandKey();
    expect(publicKey).toMatch(/^ssh-ed25519 \S+/);
    expect((await servers.getCommandKey()).publicKey).toBe(publicKey);
  });

  it("senza monitor.manage: forbidden", async () => {
    setSessionPersonId("p-laura");
    expect(await message(servers.getCommandKey())).toBe("forbidden");
  });
});
