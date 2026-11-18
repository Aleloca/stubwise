import type {
  WebhookEventId,
  WebhookFormat,
  WebhookInput,
  WebhookView,
} from "../../../data/queries";

// Review F3, I2: la modifica di un webhook manda SOLO ciò che è cambiato
// rispetto al webhook letto. Rimandare tutto il modulo toglierebbe al server
// ciò che il client non conosce (un evento nuovo del catalogo, un formato
// nuovo). Per lo stesso motivo un webhook con un formato sconosciuto non si
// modifica da qui, e con eventi sconosciuti non se ne cambiano gli eventi.

export interface WebhookForm {
  name: string;
  url: string;
  format: WebhookFormat;
  enabled: boolean;
  events: WebhookEventId[];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** I soli campi cambiati (vuoto = niente da salvare). */
export function patchOf(w: WebhookView, form: WebhookForm): Partial<WebhookInput> {
  const patch: Partial<WebhookInput> = {};
  if (form.name.trim() !== w.name) patch.name = form.name.trim();
  if (form.url.trim() !== w.url) patch.url = form.url.trim();
  if (form.format !== w.format) patch.format = form.format;
  if (form.enabled !== w.enabled) patch.enabled = form.enabled;
  if (!sameSet(form.events, w.events)) patch.events = form.events;
  return patch;
}

/** Cosa non si modifica da qui: tutto, con un formato sconosciuto; gli eventi, con eventi sconosciuti. */
export function editBlockOf(w: WebhookView): { form: boolean; events: boolean } {
  const form = !!w.formatUnknown;
  return { form, events: form || !!w.unknownEvents };
}
