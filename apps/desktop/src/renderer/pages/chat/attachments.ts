import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_TYPES,
  CHAT_ATTACHMENTS_PER_MESSAGE,
  chatAttachmentAllowed,
} from "@stubwise/shared";
import { isAppBuild } from "../../data/build";

// Gli allegati della casella della Chat (canale e thread). Nella build app i
// limiti sono quelli del server (fetta 4, decisione del maintainer: 25 MB per
// file, 10 per messaggio, niente eseguibili) e il tipo si controlla PRIMA del
// caricamento con la stessa regola del server (`chatAttachmentAllowed`: tipo ed
// estensione coerenti). Il prototipo resta com'era (20 MB, ogni tipo).

const PROTOTYPE_MAX_BYTES = 20 * 1024 * 1024;

export function attachmentLimits(): { count: number; bytes: number; mb: number } {
  const bytes = isAppBuild() ? CHAT_ATTACHMENT_MAX_BYTES : PROTOTYPE_MAX_BYTES;
  return { count: CHAT_ATTACHMENTS_PER_MESSAGE, bytes, mb: bytes / (1024 * 1024) };
}

/** Le estensioni ammesse, di qualunque tipo. */
const ALLOWED_EXTENSIONS = new Set(Object.values(CHAT_ATTACHMENT_TYPES).flat());

/**
 * Il tipo di un file: con un tipo, tipo ed estensione devono essere coerenti;
 * senza (il sistema non lo sa dire), decide l'estensione. L'ultima parola
 * resta al server, che il tipo lo riconosce da sé.
 */
function allowed(file: File): boolean {
  if (file.type !== "") return chatAttachmentAllowed(file.name, file.type);
  const base = file.name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && ALLOWED_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Perché un file non entra nella casella; `null` = entra. */
export function attachmentRefusal(file: File): "tooBig" | "type" | null {
  if (file.size > attachmentLimits().bytes) return "tooBig";
  if (isAppBuild() && !allowed(file)) return "type";
  return null;
}

/** I rifiuti dell'invio dovuti agli allegati (l'upload nel canale), come frase di «Not sent». */
const SEND_REFUSALS: Record<string, string> = {
  "invalid: attachmentType": "chat.attachments.notSent.type",
  "invalid: attachmentSize": "chat.attachments.notSent.size",
  "invalid: attachmentsOff": "chat.attachments.notSent.off",
  "invalid: attachments": "chat.attachments.notSent.gone",
};

/** La chiave i18n del perché di un invio fallito per un allegato; `null` per gli altri errori. */
export function sendRefusalKey(error: unknown): string | null {
  return error instanceof Error ? (SEND_REFUSALS[error.message] ?? null) : null;
}
