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

function requester(lastRequest: NonNullable<PrCycle["lastRequest"]>): PrCycleSegment {
  if (lastRequest.via === "stubwise") {
    return { key: "tickets:cycle.requestedInStubwise", params: { name: lastRequest.name } };
  }
  // `?? null`: il web fa un cast, e un server con la prima forma del ciclo
  // non manda `platform` — allora si dice «sulla PR», che è comunque vero.
  const platform = lastRequest.platform ?? null;
  const label = platform ? PLATFORM_LABEL[platform] : undefined;
  return label
    ? { key: "tickets:cycle.requestedOnPlatform", params: { name: lastRequest.name, platform: label } }
    : { key: "tickets:cycle.requestedOnPr", params: { name: lastRequest.name } };
}

/**
 * PERCHÉ una correzione `correcting` è ferma, già detto dal server
 * (`heldReason`). `canResume` lo calcola il SERVER col ruolo di chi guarda
 * (`canResumeCorrection`): qui si LEGGE, mai si deduce dal ruolo — la funzione
 * il ruolo non lo riceve nemmeno. Ferma per budget e non riprendibile da chi
 * guarda → «la riprende un maintainer». Un motivo che il web non conosce si
 * legge come `heldOther`: non lancia, e non promette niente.
 */
function heldSegment(heldReason: NonNullable<PrCycle["heldReason"]>, canResume: boolean): PrCycleSegment {
  switch (heldReason) {
    case "budget":
      return canResume
        ? { key: "tickets:cycle.heldBudget", params: {} }
        : { key: "tickets:cycle.heldBudgetNeedsMaintainer", params: {} };
    case "limit":
      return { key: "tickets:cycle.heldLimit", params: {} };
    default:
      return { key: "tickets:cycle.heldOther", params: {} };
  }
}

function stateSegments(cycle: PrCycle): PrCycleSegment[] {
  switch (cycle.state) {
    case "reviewing":
      return [{ key: "tickets:cycle.reviewing", params: {} }];
    case "correcting": {
      // `?? null` / `?? false`: il web fa un cast, non un parse, e un server
      // più vecchio del bundle non manda i due campi. Senza la difesa
      // `undefined !== null` direbbe «ferma» a una correzione che lavora.
      const heldReason = cycle.heldReason ?? null;
      const canResume = cycle.canResume ?? false;
      if (heldReason !== null) {
        // Il giro resta, il motivo prende il posto di «correzione in corso»:
        // «Giro 2 di 3 · Correzione ferma · budget esaurito». Stessa forma
        // dell'app (Tappa F, F2).
        const held = heldSegment(heldReason, canResume);
        return cycle.round > 0
          ? [{ key: "tickets:cycle.round", params: { round: cycle.round, max: cycle.maxRounds } }, held]
          : [held];
      }
      return cycle.round > 0
        ? [{ key: "tickets:cycle.correctingRound", params: { round: cycle.round, max: cycle.maxRounds } }]
        : [{ key: "tickets:cycle.correcting", params: {} }];
    }
    case "approved":
      return [{ key: "tickets:cycle.approved", params: {} }];
    case "changes_requested":
      return [{ key: "tickets:cycle.changesRequested", params: {} }];
    case "stopped_at_cap":
      return [{ key: "tickets:cycle.stoppedAtCap", params: { count: cycle.round } }];
    case "correction_failed":
      return [{ key: "tickets:cycle.correctionFailed", params: {} }];
    case "idle":
      return [{ key: "tickets:cycle.idle", params: {} }];
    default:
      // Il web fa un cast, non un parse: uno stato aggiunto al server prima
      // che il bundle lo conosca arriva qui invece di far lanciare il render.
      return [{ key: "tickets:cycle.unknown", params: {} }];
  }
}

/**
 * Il tono: quello dello stato, tranne una correzione ferma. Ferma per il
 * limite del provider riparte da sola (resta `sky`, «sta lavorando»); ferma
 * per budget o per altro serve qualcuno (`signal`).
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
 * Gemella della funzione dell'app (Tappa F): le frasi devono restare le
 * stesse sulle due superfici.
 */
export function prCycleLineFor(cycle: PrCycle): PrCycleLine {
  const segments: PrCycleSegment[] = [];
  // Una correzione chiesta da una PERSONA (giro 0) dice chi l'ha chiesta:
  // è la risposta a «perché sta lavorando?».
  if (cycle.state === "correcting" && cycle.round === 0 && cycle.lastRequest) {
    segments.push(requester(cycle.lastRequest));
  }
  segments.push(...stateSegments(cycle));
  // Una richiesta umana in attesa parte appena finisce il lavoro in corso sul
  // TICKET (il job vivo blocca per ticket, non per PR: può essere la correzione
  // di un'altra PR): si dice, con chi l'ha fatta. Nessun campo nuovo: lo dice
  // il testo di `cycle.queued`.
  if (cycle.pendingRequest && cycle.lastRequest) {
    segments.push(requester(cycle.lastRequest), { key: "tickets:cycle.queued", params: {} });
  }
  return { tone: toneFor(cycle), segments };
}
