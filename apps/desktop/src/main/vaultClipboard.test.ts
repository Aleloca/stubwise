// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chooseClipboard, electronClipboard, helperClipboard } from "./vaultClipboard";

// Revisione di sicurezza della cassaforte, M4: la password copiata va negli
// appunti coi tipi `org.nspasteboard.ConcealedType`/`TransientType` (i gestori
// di appunti non la tengono) — lo fa l'helper Swift, perché da Electron ogni
// scrittura sostituisce tutto. Si svuotano dopo 30 s SOLO se nessuno li ha
// cambiati nel frattempo. Senza l'helper, il ripiego di Electron: il testo.

describe("gli appunti della cassaforte", () => {
  it("dall'helper: copia (tipi Concealed/Transient) e svuota solo se il changeCount è ancora quello", async () => {
    const seen: string[] = [];
    const clip = helperClipboard({
      copy: async (text) => {
        seen.push(`copy:${text}`);
        return 41;
      },
      clearIf: async (n) => {
        seen.push(`clear-if:${n}`);
        return true;
      },
    });
    const token = await clip.copy("pw");
    await clip.clearIf(token);
    expect(seen).toEqual(["copy:pw", "clear-if:41"]);
  });

  it("ripiego Electron: svuota solo se c'è ancora quella password; non poter rileggere li svuota comunque", async () => {
    let board = "";
    const electron = { writeText: (t: string) => void (board = t), readText: () => board };
    const clip = electronClipboard(electron);
    const token = await clip.copy("pw");
    board = "altro";
    await clip.clearIf(token);
    expect(board).toBe("altro");
    await clip.clearIf(await clip.copy("pw"));
    expect(board).toBe("");
    const broken = electronClipboard({
      writeText: (t: string) => void (board = t),
      readText: () => {
        throw new Error("denied");
      },
    });
    await broken.clearIf(await broken.copy("pw"));
    expect(board).toBe("");
  });

  it("si sceglie a ogni copia: l'helper dove c'è l'enclave, altrimenti Electron; lo svuota chi ha scritto", async () => {
    const seen: string[] = [];
    let enclave = true;
    const clip = chooseClipboard({
      useHelper: async () => enclave,
      helper: {
        copy: async () => {
          seen.push("helper:copy");
          return 7;
        },
        clearIf: async () => {
          seen.push("helper:clear");
        },
      },
      electron: {
        copy: async () => {
          seen.push("electron:copy");
          return "pw";
        },
        clearIf: async () => {
          seen.push("electron:clear");
        },
      },
    });
    const a = await clip.copy("pw");
    enclave = false;
    await clip.clearIf(a);
    await clip.clearIf(await clip.copy("pw"));
    expect(seen).toEqual(["helper:copy", "helper:clear", "electron:copy", "electron:clear"]);
  });
});
