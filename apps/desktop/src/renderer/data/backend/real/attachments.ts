import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import { appClient } from "./client";
import { reread } from "./tasks";

// Gli allegati della build app (integrazione area 2, fetta 1): le rotte e i
// limiti di oggi (`/api/tickets/:ticketId/attachments`, 10 MB, l'allowlist
// dei tipi), gli stessi allegati che vedono web vecchio e mobile.

/** Gli allegati sono spenti sull'istanza (nessuno storage configurato): la pagina lo dice. */
export class AttachmentsOffError extends Error {
  constructor() {
    super("attachments_off");
    this.name = "AttachmentsOffError";
  }
}

const offOrThrow = (error: unknown): never => {
  if (error instanceof ApiError && error.code === "storage_not_configured") throw new AttachmentsOffError();
  throw error;
};

export const addAttachment: typeof Fake.addAttachment = async (id, input) => {
  if (!input.file) throw new Error("invalid: file");
  const form = new FormData();
  form.append("file", input.file, input.name);
  try {
    await appClient().request("POST", `/api/tickets/${encodeURIComponent(id)}/attachments`, form);
  } catch (error) {
    offOrThrow(error);
  }
  return reread(id);
};

export const removeAttachment: typeof Fake.removeAttachment = async (id, attachmentId) => {
  try {
    await appClient().request("DELETE", `/api/attachments/${encodeURIComponent(attachmentId)}`);
  } catch (error) {
    offOrThrow(error);
  }
  return reread(id);
};
