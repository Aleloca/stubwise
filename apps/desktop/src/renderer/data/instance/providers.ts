import { forgetSecret, storeProvidedSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { gate, newId, now, state } from "../store";
import { forbidden, writer } from "../writer";
import { isLimited } from "./blocks";
import { canI, reauthRefusal, refuse } from "./common";
import type { AiProvider, TestOutcome } from "./state";
import type { InstanceRefusal, InstanceResult } from "./types";

// I provider dell'AI (area 9b, Task 3): la catena degli account con cui
// Claude lavora. L'ordine dell'array `state.instance.providers` È la catena;
// `pickProvider` (in `blocks.ts`, la foglia che leggono le partenze dei
// lavori) sceglie da lì. Si scrivono con `ai_providers.manage`; si leggono
// anche con `settings.manage`, in sola lettura.
//
// La chiave (chiave API o setup-token) va nel caveau (`storeProvidedSecret`)
// e qui restano solo l'id e le ultime 4 cifre: nessuna lettura, voce o
// notifica la riporta (RF 1). Aggiungere, sostituire la chiave ed eliminare
// chiedono la riconferma (+R).
//
// Scelta del controller: l'ultimo provider abilitato non si disabilita né si
// elimina (`invalid: "last_enabled_provider"`): un'istanza senza AI non è
// uno stato che il prototipo deve reggere.

export { pickProvider } from "./blocks";

const MANAGE = "ai_providers.manage";
/** Da qui la quota di un abbonamento è «vicina al limite». */
export const QUOTA_NEAR_PCT = 80;
/**
 * Oltre questa percentuale della settimana il lavoro di sfondo (Docs
 * notturni, report) aspetta il reset settimanale (deploy-log, «Quota degli
 * account»). La pagina lo dice in una riga; il prototipo non lo simula.
 */
export const BACKGROUND_WEEKLY_THRESHOLD = 90;

export interface QuotaView {
  fiveHourPct: number;
  weeklyPct: number;
  readAt: string;
  band: "ok" | "near" | "limited";
  limitedUntil: string | null;
}

export type ProviderView = Omit<AiProvider, "secretId" | "quota"> & {
  /** La posizione nella catena, da 1 (un disabilitato tiene il suo posto). */
  position: number;
  quota: QuotaView | null;
};

const providerOf = (id: string) => state.instance.providers.find((p) => p.id === id);
const objectOf = (p: AiProvider) => ({ type: "provider", id: p.id, label: p.name });
const onOff = (enabled: boolean) => (enabled ? "On" : "Off");
const chain = () => state.instance.providers.map((p) => p.name).join(", ");

/** Chi legge la voce AI: chi gestisce i provider o le impostazioni. */
const canRead = (me: string) => canI(me, MANAGE) || canI(me, "settings.manage");

function quotaView(p: AiProvider): QuotaView | null {
  if (!p.quota) return null;
  const { fiveHourPct, weeklyPct, readAt, limitedUntil } = p.quota;
  const band = isLimited(p)
    ? "limited"
    : Math.max(fiveHourPct, weeklyPct) >= QUOTA_NEAR_PCT
      ? "near"
      : "ok";
  return { fiveHourPct, weeklyPct, readAt, band, limitedUntil };
}

/** Campo per campo, mai `...p`: un campo nuovo della riga non esce da solo (e `secretId` mai). */
function viewOf(p: AiProvider, index: number): ProviderView {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    enabled: p.enabled,
    last4: p.last4,
    createdAt: p.createdAt,
    lastTest: p.lastTest ? { ...p.lastTest } : null,
    position: index + 1,
    quota: quotaView(p),
  };
}

/** Il provider su cui agire: con il permesso (o `forbidden`), esistente (o `not_found`). */
function managed(me: string, id: string): { provider: AiProvider } | { refusal: InstanceRefusal } {
  if (!canI(me, MANAGE)) return { refusal: refuse.forbidden() };
  const provider = providerOf(id);
  return provider ? { provider } : { refusal: refuse.notFound() };
}

/** È l'unico abilitato: spegnerlo o eliminarlo lascerebbe l'istanza senza AI. */
const isLastEnabled = (p: AiProvider): boolean =>
  p.enabled && state.instance.providers.filter((x) => x.enabled).length === 1;

/** La catena, nell'ordine, senza i segreti. */
export async function listProviders(): Promise<ProviderView[]> {
  const me = await gate("instance.listProviders");
  if (!canRead(me)) throw forbidden();
  return state.instance.providers.map(viewOf);
}

/** Aggiunge un account in fondo alla catena, abilitato (+R). */
export async function createProvider(input: {
  name: string;
  kind: AiProvider["kind"];
  credential: string;
}): Promise<InstanceResult<{ providerId: string }>> {
  const me = await writer("instance.createProvider");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const name = input.name.trim();
  if (!name) return refuse.invalid("name");
  if (input.kind !== "subscription" && input.kind !== "api_key") return refuse.invalid("kind");
  const credential = input.credential.trim();
  if (!credential) return refuse.invalid("credential");
  if (state.instance.providers.some((p) => p.name.toLowerCase() === name.toLowerCase()))
    return refuse.conflict();
  const blocked = reauthRefusal(me, "instance.createProvider");
  if (blocked) return blocked;

  const id = newId("prv");
  const secret = storeProvidedSecret("provider_credential", id, credential);
  const provider: AiProvider = {
    id,
    name,
    kind: input.kind,
    enabled: true,
    secretId: secret.id,
    last4: secret.last4,
    // Un abbonamento nuovo non ha ancora una lettura della quota.
    quota: null,
    lastTest: null,
    createdAt: now(),
  };
  state.instance.providers.push(provider);
  recordChange({
    kind: "provider.created",
    actorId: me,
    projectId: null,
    object: objectOf(provider),
    params: { kind: provider.kind },
  });
  return { ok: true, providerId: id };
}

/** Accende o spegne un account; l'ultimo abilitato non si spegne. */
export async function setProviderEnabled(id: string, enabled: boolean): Promise<InstanceResult> {
  const me = await writer("instance.setProviderEnabled");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { provider } = found;
  if (provider.enabled === enabled) return { ok: true };
  if (!enabled && isLastEnabled(provider)) return refuse.invalid("last_enabled_provider");
  provider.enabled = enabled;
  recordChange({
    kind: "provider.updated",
    actorId: me,
    projectId: null,
    object: objectOf(provider),
    before: onOff(!enabled),
    after: onOff(enabled),
  });
  return { ok: true };
}

/** Sposta un account al posto `toIndex` della catena (da 0). */
export async function moveProvider(id: string, toIndex: number): Promise<InstanceResult> {
  const me = await writer("instance.moveProvider");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const list = state.instance.providers;
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= list.length)
    return refuse.invalid("index");
  const from = list.indexOf(found.provider);
  if (from === toIndex) return { ok: true };
  const before = chain();
  list.splice(from, 1);
  list.splice(toIndex, 0, found.provider);
  recordChange({
    kind: "provider.reordered",
    actorId: me,
    projectId: null,
    object: objectOf(found.provider),
    before,
    after: chain(),
  });
  return { ok: true };
}

/**
 * Prova l'account: l'esito è quello scelto nel riquadro «Prototype only»
 * (`simulateNextTest`, vale una volta), altrimenti `ok`. Si salva in
 * `lastTest`; una prova non è una modifica, quindi nessuna voce.
 */
export async function testProvider(id: string): Promise<InstanceResult<{ outcome: TestOutcome }>> {
  const me = await writer("instance.testProvider");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const next = state.instance.simulate.nextTest;
  const outcome = next[id] ?? "ok";
  delete next[id];
  found.provider.lastTest = { at: now(), outcome };
  return { ok: true, outcome };
}

/** Sostituisce la chiave (+R): la vecchia esce dal caveau, la riga torna «non ancora provato». */
export async function replaceProviderCredential(
  id: string,
  credential: string,
): Promise<InstanceResult> {
  const me = await writer("instance.replaceProviderCredential");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const value = credential.trim();
  if (!value) return refuse.invalid("credential");
  const blocked = reauthRefusal(me, "instance.replaceProviderCredential");
  if (blocked) return blocked;

  const { provider } = found;
  forgetSecret(provider.secretId);
  const secret = storeProvidedSecret("provider_credential", provider.id, value);
  provider.secretId = secret.id;
  provider.last4 = secret.last4;
  provider.lastTest = null;
  // Il registro dice «sostituita», mai il valore: nessun prima/dopo.
  recordChange({
    kind: "provider.credential_replaced",
    actorId: me,
    projectId: null,
    object: objectOf(provider),
  });
  return { ok: true };
}

/** Elimina un account (+R); l'ultimo abilitato non si elimina. */
export async function deleteProvider(id: string): Promise<InstanceResult> {
  const me = await writer("instance.deleteProvider");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { provider } = found;
  if (isLastEnabled(provider)) return refuse.invalid("last_enabled_provider");
  const blocked = reauthRefusal(me, "instance.deleteProvider");
  if (blocked) return blocked;

  forgetSecret(provider.secretId);
  state.instance.providers = state.instance.providers.filter((p) => p.id !== id);
  recordChange({
    kind: "provider.deleted",
    actorId: me,
    projectId: null,
    object: objectOf(provider),
  });
  return { ok: true };
}

/**
 * SOLO PROTOTIPO (riquadro «Prototype only»): l'esito della prossima prova
 * di un provider, di un account git, dell'archiviazione (`"storage"`) o del
 * webhook (`"webhook"`). Lo sceglie chi può fare quella prova; nessuna voce.
 */
export async function simulateNextTest(
  target: string,
  outcome: TestOutcome,
): Promise<InstanceResult> {
  const me = await writer("instance.simulateNextTest");
  const permission = providerOf(target)
    ? MANAGE
    : state.instance.gitAccounts.some((g) => g.id === target)
      ? "git_accounts.manage"
      : target === "storage" || target === "webhook"
        ? "settings.manage"
        : null;
  if (permission === null) return refuse.notFound();
  if (!canI(me, permission)) return refuse.forbidden();
  state.instance.simulate.nextTest[target] = outcome;
  return { ok: true };
}
