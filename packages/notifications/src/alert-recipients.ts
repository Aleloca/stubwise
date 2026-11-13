import { defaultApplies, type AlertType, type MandatoryReason } from "@stubwise/shared";

/**
 * I DESTINATARI di un avviso del catalogo (area 8, F2, S2): PURA, il
 * contesto lo legge `publish.ts`. Alla pubblicazione la card nasce per chi
 * risulta qui ADESSO: «lo stato dell'iscrizione al momento dell'avviso» è lo
 * stato di questo istante (ruling della F2: nessuna storia).
 *
 * - gli OBBLIGATORI (risolti dal produttore: chi ha fatto il merge, l'autore
 *   della PR o della task…) la ricevono sempre, anche con l'iscrizione spenta;
 * - un tipo `mandatoryOnly` va SOLO a loro;
 * - gli altri membri del progetto: se possono iscriversi (`subscribe.perm`, o
 *   l'esserne membri) e l'iscrizione è accesa — la riga di
 *   `alert_subscriptions`, o senza riga il default del catalogo dai permessi
 *   di adesso (`appDefaultOn ?? defaultOn`, più `defaultForFullAdmins`);
 * - il Telefono (push): la riga, o `defaultPhone`. Per i tipi del catalogo
 *   SOSTITUISCE l'interruttore `push` della persona (M-2 = b).
 * Tutti dentro chi VEDE il progetto (`members`).
 */
export interface CatalogRecipientsContext {
  /** Chi vede il progetto adesso (membri + full admin). */
  members: readonly string[];
  /** I full admin dell'istanza. */
  fullAdmins: ReadonlySet<string>;
  /** Se `userId` ha il permesso nel progetto adesso (i full admin li hanno tutti). */
  holds: (userId: string, perm: string) => boolean;
  /** Le iscrizioni scritte (per questo progetto e tipo). */
  subscriptions: ReadonlyMap<string, { app: boolean; phone: boolean }>;
  /** I destinatari obbligatori, coi loro motivi. */
  mandatory: readonly { userId: string; reason: MandatoryReason }[];
}

export interface CatalogRecipients {
  /** Chi riceve la card in inbox. */
  app: string[];
  /** Chi riceve anche il push (sottoinsieme di `app`). */
  phone: Set<string>;
  /** Chi la riceve da OBBLIGATORIO, col motivo (la card lo porta: lettura e «mute»). */
  mandatory: Map<string, MandatoryReason>;
}

export function catalogRecipients(type: AlertType, ctx: CatalogRecipientsContext): CatalogRecipients {
  const visible = new Set(ctx.members);
  const app: string[] = [];
  const phone = new Set<string>();
  const mandatory = new Map<string, MandatoryReason>();
  const add = (userId: string, wantsPhone: boolean) => {
    if (!visible.has(userId) || app.includes(userId)) return;
    app.push(userId);
    if (wantsPhone) phone.add(userId);
  };
  // Gli obbligatori, sempre (solo i motivi che il tipo prevede).
  for (const m of ctx.mandatory) {
    if (!type.mandatory.includes(m.reason)) continue;
    add(m.userId, ctx.subscriptions.get(m.userId)?.phone ?? type.defaultPhone);
    if (app.includes(m.userId) && !mandatory.has(m.userId)) mandatory.set(m.userId, m.reason);
  }
  if (type.mandatoryOnly) return { app, phone, mandatory };
  const rule = type.appDefaultOn ?? type.defaultOn;
  for (const userId of ctx.members) {
    const canSubscribe = type.subscribe.perm === "member" || ctx.holds(userId, type.subscribe.perm);
    if (!canSubscribe) continue;
    const sub = ctx.subscriptions.get(userId);
    const on = sub
      ? sub.app
      : defaultApplies(rule, (perm) => ctx.holds(userId, perm)) || (type.defaultForFullAdmins === true && ctx.fullAdmins.has(userId));
    if (on) add(userId, sub ? sub.phone : type.defaultPhone);
  }
  return { app, phone, mandatory };
}
