import type { PrCycle } from "./api";

export type PrCycleTone = "sky" | "ok" | "signal" | "faint" | "danger";

export interface PrCycleSegment {
  key: string;
  params: Record<string, unknown>;
}

export interface PrCycleLine {
  tone: PrCycleTone;
  /** Pezzi della riga, da unire con " · " DOPO la traduzione. */
  segments: PrCycleSegment[];
}

const TONE_BY_STATE: Record<PrCycle["state"], PrCycleTone> = {
  reviewing: "sky",
  correcting: "sky",
  approved: "ok",
  changes_requested: "signal",
  stopped_at_cap: "signal",
  correction_failed: "danger",
  idle: "faint",
};

/** Colore-testo Tailwind per tono, stesso set di `PULSE_TONE_CLASS` più `danger`. */
export const PR_CYCLE_TONE_CLASS: Record<PrCycleTone, string> = {
  sky: "text-sky-400",
  ok: "text-ok",
  signal: "text-signal",
  faint: "text-fg-faint",
  danger: "text-danger",
};

/** Nome della piattaforma per la frase: è un nome proprio, non si traduce. */
const PLATFORM_LABEL: Record<"bitbucket" | "github", string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
};

/**
 * Chi ha chiesto le modifiche. `name` può essere `""` (`derivePrCycle` non ha
 * né login né email): allora la frase OMETTE «da X» — mai «da » seguito dal
 * vuoto. `trim()` perché un nome di soli spazi è vuoto quanto `""`.
 */
function requester(lastRequest: NonNullable<PrCycle["lastRequest"]>): PrCycleSegment {
  const name = lastRequest.name.trim();
  if (lastRequest.via === "stubwise") {
    return name === ""
      ? { key: "tickets:cycle.requestedInStubwiseAnon", params: {} }
      : { key: "tickets:cycle.requestedInStubwise", params: { name } };
  }
  // `?? null`: il web fa un cast, e un server con la prima forma del ciclo
  // non manda `platform` — allora si dice «sulla PR», che è comunque vero.
  const platform = lastRequest.platform ?? null;
  const label = platform ? PLATFORM_LABEL[platform] : undefined;
  if (label) {
    return name === ""
      ? { key: "tickets:cycle.requestedOnPlatformAnon", params: { platform: label } }
      : { key: "tickets:cycle.requestedOnPlatform", params: { name, platform: label } };
  }
  return name === ""
    ? { key: "tickets:cycle.requestedOnPrAnon", params: {} }
    : { key: "tickets:cycle.requestedOnPr", params: { name } };
}

/**
 * PERCHÉ una correzione `correcting` è ferma, già detto dal server
 * (`heldReason`). `canResume` lo calcola il SERVER col ruolo di chi guarda
 * (`canResumeCorrection`): qui si LEGGE, mai si deduce dal ruolo — la funzione
 * il ruolo non lo riceve nemmeno. Ferma per budget e non riprendibile da chi
 * guarda → «chiedi a un maintainer di riprenderla». Un motivo che il web non
 * conosce si legge come `heldOther`: non lancia, e non promette niente.
 *
 * Con un giro (`round > 0`) la chiave è la variante `…Round`, una frase SOLA
 * e minuscola dopo il giro, come `correctingRound`: «Giro 2 di 3 · correzione
 * ferma · budget esaurito». F2 deve usare questa forma (stesse chiavi, stessi
 * testi) sull'app.
 */
function heldSegment(cycle: PrCycle, heldReason: NonNullable<PrCycle["heldReason"]>, canResume: boolean): PrCycleSegment {
  const base =
    heldReason === "budget"
      ? canResume
        ? "heldBudget"
        : "heldBudgetNeedsMaintainer"
      : heldReason === "limit"
        ? "heldLimit"
        : "heldOther";
  return cycle.round > 0
    ? { key: `tickets:cycle.${base}Round`, params: { round: cycle.round, max: cycle.maxRounds } }
    : { key: `tickets:cycle.${base}`, params: {} };
}

function stateSegment(cycle: PrCycle): PrCycleSegment {
  switch (cycle.state) {
    case "reviewing":
      return { key: "tickets:cycle.reviewing", params: {} };
    case "correcting": {
      // `?? null` / `?? false`: il web fa un cast, non un parse, e un server
      // più vecchio del bundle non manda i due campi. Senza la difesa
      // `undefined !== null` direbbe «ferma» a una correzione che lavora.
      const heldReason = cycle.heldReason ?? null;
      const canResume = cycle.canResume ?? false;
      if (heldReason !== null) return heldSegment(cycle, heldReason, canResume);
      return cycle.round > 0
        ? { key: "tickets:cycle.correctingRound", params: { round: cycle.round, max: cycle.maxRounds } }
        : { key: "tickets:cycle.correcting", params: {} };
    }
    case "approved":
      return { key: "tickets:cycle.approved", params: {} };
    case "changes_requested":
      return { key: "tickets:cycle.changesRequested", params: {} };
    case "stopped_at_cap":
      return { key: "tickets:cycle.stoppedAtCap", params: { count: cycle.round } };
    case "correction_failed":
      return { key: "tickets:cycle.correctionFailed", params: {} };
    case "idle":
      return { key: "tickets:cycle.idle", params: {} };
    default:
      // Il web fa un cast, non un parse: uno stato aggiunto al server prima
      // che il bundle lo conosca arriva qui invece di far lanciare il render.
      return { key: "tickets:cycle.unknown", params: {} };
  }
}

/**
 * Il tono: quello dello stato, tranne una correzione ferma per budget o per
 * altro, che vuole qualcuno (`signal`).
 *
 * Ferma per il LIMITE del provider resta `sky`, e non è una svista: nella
 * timeline del ticket il badge dello stato del job `held` è `text-signal`
 * (`badges.tsx`), ma quel badge descrive il JOB, parcheggiato per qualunque
 * motivo. Qui la riga sa PERCHÉ è fermo, e per il limite la correzione
 * riparte da sola quando il limite si libera: nessuno deve fare niente, quindi
 * il tono resta quello di «sta lavorando».
 */
function toneFor(cycle: PrCycle): PrCycleTone {
  if (cycle.state === "correcting") {
    const heldReason = cycle.heldReason ?? null;
    if (heldReason !== null && heldReason !== "limit") return "signal";
  }
  return TONE_BY_STATE[cycle.state] ?? "faint";
}

/**
 * La riga di stato del ciclo review → correzione sotto una PR del ticket
 * (design §9: «Giro 2 di 3 · correzione in corso», «Approvata dalla review ·
 * pronta per il merge», «Modifiche richieste da mario.rossi su Bitbucket · in
 * coda»). «Pronta per il merge» e non «tocca a te»: il merge non spetta a un
 * operatore (i due divieti dell'operatore, CLAUDE.md).
 *
 * Legge SOLO ciò che il server ha derivato (`cycle`): nessuna regola del ciclo
 * è riscritta qui, e in particolare chi può riprendere una correzione ferma lo
 * dice `cycle.canResume`, non il ruolo dell'utente (che non è un input).
 * Gemella della funzione dell'app (Tappa F): F2 deve usare questa forma,
 * segmento per segmento, con gli stessi testi.
 */
export function prCycleLineFor(cycle: PrCycle): PrCycleLine {
  const segments: PrCycleSegment[] = [];
  // Una correzione chiesta da una PERSONA (giro 0) dice chi l'ha chiesta: è la
  // risposta a «perché sta lavorando?». MA `lastRequest` è la richiesta umana
  // PIÙ RECENTE (`derivePrCycle`), cioè quella in attesa se ce n'è una: con
  // `pendingRequest` attribuirebbe a chi aspetta il lavoro di un altro, e lo
  // ripeterebbe accanto a «in coda». Allora il prefisso si tace: il nome sta
  // solo dove è vero, davanti a «in coda».
  if (cycle.state === "correcting" && cycle.round === 0 && cycle.lastRequest && !cycle.pendingRequest) {
    segments.push(requester(cycle.lastRequest));
  }
  segments.push(stateSegment(cycle));
  // Una richiesta umana in attesa parte appena finisce il lavoro in corso sul
  // TICKET (il job vivo blocca per ticket, non per PR: può essere la correzione
  // di un'altra PR): si dice, con chi l'ha fatta. Nessun campo nuovo: lo dice
  // il testo di `cycle.queued`.
  if (cycle.pendingRequest && cycle.lastRequest) {
    segments.push(requester(cycle.lastRequest), { key: "tickets:cycle.queued", params: {} });
  }
  return { tone: toneFor(cycle), segments };
}
