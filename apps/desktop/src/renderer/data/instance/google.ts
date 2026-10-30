import { forgetSecret, storeProvidedSecret } from "../admin/secrets";
import { visiblePeopleFor } from "../access/whoCan";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import type { GoogleWorkspace } from "../me/types";
import { gate, newId, now, state } from "../store";
import { forbidden, writer } from "../writer";
import { canI, nameOf, reauthRefusal, refuse } from "./common";
import type { InstanceRefusal, InstanceResult } from "./types";

// Le app Google d'istanza (area 9b, Task 4): ognuna copre uno o più domini
// email, e chi ha un indirizzo di quei domini collega la sua casella in
// Preferenze → Account (`me/google.ts` legge la STESSA riga,
// `state.googleWorkspaces`). Si leggono e si scrivono con
// `integrations.manage`. Il client secret va nel caveau: qui restano l'id e
// le ultime 4 cifre (RF 1). Aggiungere, sostituire il secret ed eliminare
// chiedono la riconferma (+R); modificare no.
//
// Un dominio appartiene a una sola app. Un'app con caselle collegate non si
// elimina: il rifiuto nomina le persone che chi guarda vede e conta le
// altre (R-G5).

const MANAGE = "integrations.manage";
/** Un nome di dominio: etichette di lettere, cifre e trattini, separate da punti, con un TLD. */
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface GoogleAppView {
  id: string;
  name: string;
  domains: string[];
  clientId: string;
  last4: string;
  createdAt: string;
  /** Le caselle collegate con un indirizzo dei suoi domini (un numero: non nomina nessuno). */
  mailboxCount: number;
}

const appOf = (id: string) => state.googleWorkspaces.find((w) => w.id === id);
const objectOf = (w: GoogleWorkspace) => ({ type: "google_app", id: w.id, label: w.name });
const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const mailboxesOf = (w: GoogleWorkspace) =>
  state.mailboxes.filter((b) => w.domains.includes(domainOf(b.email)));

/** Campo per campo: `secretId` non esce. */
function viewOf(w: GoogleWorkspace): GoogleAppView {
  return {
    id: w.id,
    name: w.name,
    domains: [...w.domains],
    clientId: w.clientId,
    last4: w.last4,
    createdAt: w.createdAt,
    mailboxCount: mailboxesOf(w).length,
  };
}

function managed(me: string, id: string): { app: GoogleWorkspace } | { refusal: InstanceRefusal } {
  if (!canI(me, MANAGE)) return { refusal: refuse.forbidden() };
  const app = appOf(id);
  return app ? { app } : { refusal: refuse.notFound() };
}

/**
 * I domini, puliti (minuscoli, senza doppioni, nell'ordine dato) o il
 * motivo del rifiuto: `domains` se non ce n'è nessuno, `domain` per uno
 * malformato, `domain_taken` per uno di un'altra app.
 */
function cleanDomains(input: string[], exceptId: string | null): string[] | { reason: string } {
  const domains = [...new Set(input.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (domains.length === 0) return { reason: "domains" };
  if (!domains.every((d) => DOMAIN_RE.test(d))) return { reason: "domain" };
  const taken = state.googleWorkspaces.some(
    (w) => w.id !== exceptId && w.domains.some((d) => domains.includes(d)),
  );
  return taken ? { reason: "domain_taken" } : domains;
}

const nameTaken = (name: string, exceptId: string | null) =>
  state.googleWorkspaces.some(
    (w) => w.id !== exceptId && w.name.toLowerCase() === name.toLowerCase(),
  );

/** Le app, con quante caselle sono collegate. */
export async function listGoogleApps(): Promise<GoogleAppView[]> {
  const me = await gate("instance.listGoogleApps");
  if (!canI(me, MANAGE)) throw forbidden();
  return state.googleWorkspaces.map(viewOf);
}

/** Aggiunge un'app (+R): compare subito fra quelle da collegare in Preferenze. */
export async function createGoogleApp(input: {
  name: string;
  domains: string[];
  clientId: string;
  clientSecret: string;
}): Promise<InstanceResult<{ appId: string }>> {
  const me = await writer("instance.createGoogleApp");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const name = input.name.trim();
  if (!name) return refuse.invalid("name");
  const domains = cleanDomains(input.domains, null);
  if (!Array.isArray(domains)) return refuse.invalid(domains.reason);
  const clientId = input.clientId.trim();
  if (!clientId) return refuse.invalid("client_id");
  const clientSecret = input.clientSecret.trim();
  if (!clientSecret) return refuse.invalid("client_secret");
  if (nameTaken(name, null)) return refuse.conflict();
  const blocked = reauthRefusal(me, "instance.createGoogleApp");
  if (blocked) return blocked;

  const id = newId("gw");
  const secret = storeProvidedSecret("google_client_secret", id, clientSecret);
  const app: GoogleWorkspace = {
    id,
    name,
    domains,
    clientId,
    secretId: secret.id,
    last4: secret.last4,
    createdAt: now(),
  };
  state.googleWorkspaces.push(app);
  recordChange({
    kind: "google_app.created",
    actorId: me,
    projectId: null,
    object: objectOf(app),
  });
  return { ok: true, appId: id };
}

/** Nome, domini e client ID, senza riconferma; la voce ha i soli campi cambiati. */
export async function updateGoogleApp(
  id: string,
  input: { name?: string; domains?: string[]; clientId?: string },
): Promise<InstanceResult> {
  const me = await writer("instance.updateGoogleApp");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { app } = found;
  const name = input.name === undefined ? app.name : input.name.trim();
  if (!name) return refuse.invalid("name");
  let domains = app.domains;
  if (input.domains !== undefined) {
    const cleaned = cleanDomains(input.domains, id);
    if (!Array.isArray(cleaned)) return refuse.invalid(cleaned.reason);
    domains = cleaned;
  }
  const clientId = input.clientId === undefined ? app.clientId : input.clientId.trim();
  if (!clientId) return refuse.invalid("client_id");
  if (nameTaken(name, id)) return refuse.conflict();

  const diff = changedFields(
    { name: app.name, domains: app.domains, clientId: app.clientId },
    { name, domains, clientId },
  );
  if (!diff) return { ok: true };
  app.name = name;
  app.domains = domains;
  app.clientId = clientId;
  recordChange({
    kind: "google_app.updated",
    actorId: me,
    projectId: null,
    object: objectOf(app),
    ...diff,
  });
  return { ok: true };
}

/** Sostituisce il client secret (+R): il vecchio esce dal caveau. */
export async function replaceGoogleSecret(id: string, secret: string): Promise<InstanceResult> {
  const me = await writer("instance.replaceGoogleSecret");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const value = secret.trim();
  if (!value) return refuse.invalid("client_secret");
  const blocked = reauthRefusal(me, "instance.replaceGoogleSecret");
  if (blocked) return blocked;

  const { app } = found;
  forgetSecret(app.secretId);
  const stored = storeProvidedSecret("google_client_secret", app.id, value);
  app.secretId = stored.id;
  app.last4 = stored.last4;
  recordChange({
    kind: "google_app.secret_replaced",
    actorId: me,
    projectId: null,
    object: objectOf(app),
  });
  return { ok: true };
}

/**
 * Elimina un'app (+R). Con caselle collegate → `in_use`: le persone che chi
 * guarda vede per nome, le altre contate; ognuno scollega la propria in
 * Preferenze → Account.
 */
export async function deleteGoogleApp(id: string): Promise<InstanceResult> {
  const me = await writer("instance.deleteGoogleApp");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { app } = found;
  const boxes = mailboxesOf(app);
  if (boxes.length > 0) {
    const people = visiblePeopleFor(me);
    const seen = boxes.filter((b) => people.has(b.personId));
    return refuse.inUse(
      seen.map((b) => ({ label: nameOf(b.personId)!, projectCode: null })),
      boxes.length - seen.length,
    );
  }
  const blocked = reauthRefusal(me, "instance.deleteGoogleApp");
  if (blocked) return blocked;

  forgetSecret(app.secretId);
  state.googleWorkspaces = state.googleWorkspaces.filter((w) => w.id !== id);
  recordChange({
    kind: "google_app.deleted",
    actorId: me,
    projectId: null,
    object: objectOf(app),
  });
  return { ok: true };
}
