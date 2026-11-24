import type { ObjectStorage } from "../storage/index.js";

/** Il rifiuto di un caricamento con gli allegati spenti: 409, lo manda così l'error handler. */
export class AttachmentsOffError extends Error {
  readonly statusCode = 409;
  readonly code = "attachments_off";
  constructor() {
    super("Attachments are turned off for this instance");
  }
}

/**
 * Lo storage con gli allegati SPENTI: le scritture (caricare, copiare)
 * rifiutano con {@link AttachmentsOffError}; leggere ed eliminare restano
 * (il prototipo: «spenti» ferma i caricamenti nuovi, non ciò che c'è).
 */
export function uploadsOff(storage: ObjectStorage): ObjectStorage {
  const refuse = async (): Promise<never> => {
    throw new AttachmentsOffError();
  };
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "putObject" || prop === "putObjectStream" || prop === "copyObject") return refuse;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
