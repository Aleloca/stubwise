import { describe, expect, it } from "vitest";
import * as fake from "../api";
import * as stubs from "./real/stubs.generated";
import { NotIntegratedError } from "./real/notIntegrated";

// Il punto di scambio (Task 11 dell'integrazione area 2, fetta 1): la build
// «app» risolve `@backend/api` su `real/index.ts`, che parte dagli stub
// generati da `scripts/gen-backend-stubs.mjs`. Ogni nome del finto deve
// esserci, o una pagina della build app chiamerebbe `undefined`.

describe("punto di scambio del livello dati", () => {
  it("gli stub coprono ogni esportazione del finto", () => {
    expect(Object.keys(stubs).sort()).toEqual(Object.keys(fake).sort());
  });

  it("uno stub rifiuta con NotIntegratedError", async () => {
    await expect(stubs.listTasks()).rejects.toBeInstanceOf(NotIntegratedError);
    await expect(stubs.listTasks()).rejects.toThrow(/listTasks/);
  });

  it("una funzione sincrona non integrata lancia subito", () => {
    expect(() => stubs.resetApi()).toThrow(NotIntegratedError);
  });

  it("un namespace non integrato rifiuta per ogni chiave", async () => {
    await expect(stubs.chat.listChannels()).rejects.toThrow(/chat\.listChannels/);
  });

  it("un namespace non è un thenable (await non lo scambia per una promessa)", async () => {
    expect((stubs.docs as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
