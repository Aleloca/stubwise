import type { KeyHelper } from "./keyHelper";

// Gli appunti della cassaforte (revisione di sicurezza, M4). La password
// copiata deve avere i tipi `org.nspasteboard.ConcealedType` e
// `TransientType`, così i gestori di appunti non la tengono nella cronologia:
// da Electron non si può (ogni scrittura sostituisce tutto il contenuto),
// quindi la scrive l'helper Swift. Dopo 30 s si svuotano SOLO se nessuno li ha
// cambiati nel frattempo: l'helper lo sa dal `changeCount` della pasteboard,
// il ripiego di Electron rileggendo il testo.

/** `copy` dà un segnale opaco; `clearIf` svuota solo se gli appunti sono ancora quelli. */
export interface VaultClipboard {
  copy: (text: string) => Promise<unknown>;
  clearIf: (token: unknown) => Promise<void>;
}

/** Dall'helper: i tipi Concealed/Transient, e il `changeCount` come segnale. */
export function helperClipboard(helper: Pick<KeyHelper, "copy" | "clearIf">): VaultClipboard {
  return {
    copy: (text) => helper.copy(text),
    clearIf: async (token) => {
      if (typeof token === "number") await helper.clearIf(token);
    },
  };
}

/**
 * Il ripiego di Electron (nessun helper: un build senza la cassaforte dal
 * desktop): testo semplice; svuota se c'è ancora quella password, e anche
 * quando non si possono rileggere (non è un motivo per lasciarcela).
 */
export function electronClipboard(clipboard: {
  writeText: (text: string) => void;
  readText: () => string | Promise<string>;
}): VaultClipboard {
  return {
    copy: async (text) => {
      clipboard.writeText(text);
      return text;
    },
    clearIf: async (token) => {
      let now: string | null;
      try {
        now = await clipboard.readText();
      } catch {
        now = null;
      }
      if (now === null || now === token) clipboard.writeText("");
    },
  };
}

/** Si sceglie a ogni copia (l'helper dove c'è l'enclave); svuota chi ha scritto. */
export function chooseClipboard(deps: {
  useHelper: () => Promise<boolean>;
  helper: VaultClipboard;
  electron: VaultClipboard;
}): VaultClipboard {
  return {
    copy: async (text) => {
      const via = (await deps.useHelper()) ? deps.helper : deps.electron;
      return { via, token: await via.copy(text) };
    },
    clearIf: async (written) => {
      const w = written as { via?: VaultClipboard; token?: unknown } | null;
      if (w?.via) await w.via.clearIf(w.token);
    },
  };
}
