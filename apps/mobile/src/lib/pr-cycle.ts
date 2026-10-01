import type { PrCycle, Reader, Unknown } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import type { TFunction } from "i18next";
import type { ColorToken } from "../theme/tokens";

/**
 * La riga di stato del ciclo review → correzione sotto una PR (30 set 2026,
 * design «correzioni post-PR» §9).
 *
 * ⚠️ **GEMELLA di `prCycleLineFor` del web** (`apps/web/src/lib/pr-cycle-line.ts`),
 * segmento per segmento, con gli stessi testi (`mobile.work.pr.cycle.*` ↔
 * `tickets:cycle.*`): le due superfici non possono dire cose diverse. Chi
 * cambia una regola qui la cambia anche là; il test accanto legge i cataloghi
 * del web e fallisce se i testi divergono.
 *
 * ⚠️ **Il ciclo lo DERIVA il server** (`derivePrCycle`, `@stubwise/notifications`)
 * e qui lo si mette solo in parole: due superfici che ricalcolassero lo stato
 * da job e review direbbero cose diverse, e la copia sbagliata starebbe
 * nell'app, cioè dalla parte che si aggiorna dagli store. Per lo stesso motivo
 * il RUOLO non è un input: chi può riprendere una correzione ferma lo dice
 * `cycle.canResume`, calcolato dal server col ruolo di chi guarda (stessa regola
 * di `canMerge`), e se si PUÒ chiedere una correzione lo dice
 * `cycle.canRequestCorrection` — nessuna funzione qui lo decide.
 *
 * Strutturata e non già tradotta (come `pulseLineFor`): resta pura e testabile
 * sulle CHIAVI senza montare React; `prCycleText` la mette in parole.
 */

/**
 * Stessi toni del web, come token dell'app. `sky`/`ok`/`signal`/`faint`/
 * `danger` esistono tutti in `theme/tokens.ts` con gli stessi colori del sito
 * (`sky` è il sky-400 di Tailwind, lo stesso che il web usa per questo tono):
 * nessuna traduzione di tono fra le due superfici.
 */
export type PrCycleTone = Extract<ColorToken, "sky" | "ok" | "signal" | "faint" | "danger">;

export interface PrCycleSegment {
  key: string;
  params: Record<string, unknown>;
}

export interface PrCycleLine {
  tone: PrCycleTone;
  /** Pezzi della riga, da unire con " · " DOPO la traduzione (`prCycleText`). */
  segments: PrCycleSegment[];
}

type Cycle = Reader<PrCycle>;
type KnownState = Exclude<Cycle["state"], Unknown>;

const TONE_BY_STATE: Record<KnownState, PrCycleTone> = {
  reviewing: "sky",
  correcting: "sky",
  approved: "ok",
  changes_requested: "signal",
  stopped_at_cap: "signal",
  correction_failed: "danger",
  idle: "faint",
};

/** Nome della piattaforma per la frase: è un nome proprio, non si traduce. */
const PLATFORM_LABEL: Record<"bitbucket" | "github", string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
};

const K = "mobile.work.pr.cycle";

/**
 * Chi ha chiesto le modifiche. `name` può essere `""` (`derivePrCycle` non ha
 * né login né email): allora la frase OMETTE «da X» — mai «da » seguito dal
 * vuoto. `trim()` perché un nome di soli spazi è vuoto quanto `""`.
 *
 * Un `via` sconosciuto (`UNKNOWN` da `readerSchema`) si legge come «dalla
 * piattaforma», come il web legge un valore che non conosce: è il caso che
 * non afferma niente su un account Stubwise. Una piattaforma `null` o
 * sconosciuta → «sulla PR», che è comunque vero.
 */
function requester(lastRequest: NonNullable<Cycle["lastRequest"]>): PrCycleSegment {
  const name = lastRequest.name.trim();
  if (lastRequest.via === "stubwise") {
    return name === ""
      ? { key: `${K}.requestedInStubwiseAnon`, params: {} }
      : { key: `${K}.requestedInStubwise`, params: { name } };
  }
  // `?? null`: difensivo come il web, anche se qui `readerSchema` porta già un
  // campo assente a `null` (`.default(null)`).
  const platform = lastRequest.platform ?? null;
  const label = platform !== null && !isUnknown(platform) ? PLATFORM_LABEL[platform] : undefined;
  if (label) {
    return name === ""
      ? { key: `${K}.requestedOnPlatformAnon`, params: { platform: label } }
      : { key: `${K}.requestedOnPlatform`, params: { name, platform: label } };
  }
  return name === "" ? { key: `${K}.requestedOnPrAnon`, params: {} } : { key: `${K}.requestedOnPr`, params: { name } };
}

/**
 * PERCHÉ una correzione `correcting` è ferma, già detto dal server
 * (`heldReason`). Ferma per budget e non riprendibile da chi guarda → «chiedi a
 * un maintainer di riprenderla». Un motivo che l'app non conosce (`UNKNOWN`) si
 * legge come `heldOther`: non lancia, e non promette niente.
 *
 * Con un giro (`round > 0`) la chiave è la variante `…Round`, UNA frase
 * minuscola dopo il giro, come `correctingRound` (revisione di E3).
 */
function heldSegment(cycle: Cycle, heldReason: NonNullable<Cycle["heldReason"]>, canResume: boolean): PrCycleSegment {
  const base =
    heldReason === "budget"
      ? canResume
        ? "heldBudget"
        : "heldBudgetNeedsMaintainer"
      : heldReason === "limit"
        ? "heldLimit"
        : "heldOther";
  return cycle.round > 0
    ? { key: `${K}.${base}Round`, params: { round: cycle.round, max: cycle.maxRounds } }
    : { key: `${K}.${base}`, params: {} };
}

function stateSegment(cycle: Cycle): PrCycleSegment {
  const state = cycle.state;
  if (isUnknown(state)) return { key: `${K}.unknown`, params: {} };
  switch (state) {
    case "reviewing":
      return { key: `${K}.reviewing`, params: {} };
    case "correcting": {
      // `?? null` / `?? false`: in produzione l'app parsa e i `.default()`
      // girano, quindi qui la difesa serve soprattutto DOVE NON SI PARSA —
      // fixture dei test e doppi del client (la trappola delle fixture
      // dell'app, CLAUDE.md). Senza, un `undefined !== null` direbbe «ferma»
      // a una correzione che lavora. È la stessa difesa del web, che non parsa
      // mai.
      const heldReason = cycle.heldReason ?? null;
      const canResume = cycle.canResume ?? false;
      if (heldReason !== null) return heldSegment(cycle, heldReason, canResume);
      // `round` conta i soli giri AUTOMATICI: una correzione chiesta da una
      // persona è a giro 0, e «giro 0 di 3» sarebbe una frase falsa.
      return cycle.round > 0
        ? { key: `${K}.correctingRound`, params: { round: cycle.round, max: cycle.maxRounds } }
        : { key: `${K}.correcting`, params: {} };
    }
    case "approved":
      return { key: `${K}.approved`, params: {} };
    case "changes_requested":
      return { key: `${K}.changesRequested`, params: {} };
    case "stopped_at_cap":
      // I giri EFFETTIVI, non il tetto: se il tetto cambia dopo lo stop il
      // numero resta vero. `_one`/`_other` li sceglie i18next da `count`.
      return { key: `${K}.stoppedAtCap`, params: { count: cycle.round } };
    case "correction_failed":
      return { key: `${K}.correctionFailed`, params: {} };
    case "idle":
      return { key: `${K}.idle`, params: {} };
    default: {
      // Esaustività per il compilatore: ogni stato noto ha il suo `case`, e
      // uno nuovo nell'enum rompe qui la compilazione.
      const unhandled: never = state;
      // Ma a RUNTIME uno stato grezzo arriva qui senza essere `UNKNOWN`
      // quando la risposta non è passata da `readerSchema`: fixture dei test,
      // doppi del client. Senza questo ramo la funzione tornerebbe
      // `undefined` e `prCycleText` lancerebbe, portandosi via la schermata.
      // Il web regge lo stesso caso con lo stesso `default`.
      void unhandled;
      return { key: `${K}.unknown`, params: {} };
    }
  }
}

/**
 * Il tono: quello dello stato, tranne una correzione ferma per budget o per
 * altro (anche un motivo sconosciuto), che vuole qualcuno (`signal`). Ferma per
 * il LIMITE del provider resta `sky`: riparte da sola, nessuno deve fare
 * niente (vedi il commento gemello in `toneFor` del web).
 */
function toneFor(cycle: Cycle): PrCycleTone {
  if (isUnknown(cycle.state)) return "faint";
  if (cycle.state === "correcting") {
    const heldReason = cycle.heldReason ?? null;
    if (heldReason !== null && heldReason !== "limit") return "signal";
  }
  // `?? "faint"`: uno stato grezzo non parsato (vedi il `default` di
  // `stateSegment`) non è una chiave della tabella.
  return TONE_BY_STATE[cycle.state] ?? "faint";
}

/**
 * La riga di stato del ciclo («Giro 2 di 3 · correzione in corso», «Approvata
 * dalla review · pronta per il merge», «… · Modifiche richieste da mario.rossi
 * su Bitbucket · in coda · …»). «Pronta per il merge» e non «tocca a te»: il
 * merge non spetta a un operatore (i due divieti dell'operatore, CLAUDE.md).
 *
 * Prende SOLO il ciclo: nessun parametro per il ruolo.
 */
export function prCycleLineFor(cycle: Cycle): PrCycleLine {
  const segments: PrCycleSegment[] = [];
  // Una correzione chiesta da una PERSONA (giro 0) dice prima chi l'ha
  // chiesta. MA `lastRequest` è la richiesta umana PIÙ RECENTE, cioè quella in
  // attesa se ce n'è una: con `pendingRequest` attribuirebbe a chi aspetta il
  // lavoro di un altro, e lo ripeterebbe accanto a «in coda». Allora il
  // prefisso si tace: il nome sta solo davanti a «in coda».
  if (cycle.state === "correcting" && cycle.round === 0 && cycle.lastRequest && !cycle.pendingRequest) {
    segments.push(requester(cycle.lastRequest));
  }
  segments.push(stateSegment(cycle));
  // Una richiesta umana in attesa parte appena finisce il lavoro in corso sul
  // TICKET (il job vivo blocca per ticket, non per PR): si dice, con chi l'ha
  // fatta. Senza `lastRequest` non si inventa niente, come il web.
  if (cycle.pendingRequest && cycle.lastRequest) {
    segments.push(requester(cycle.lastRequest), { key: `${K}.queued`, params: {} });
  }
  return { tone: toneFor(cycle), segments };
}

/** La riga in parole: ogni segmento tradotto, uniti da « · » (come il web). */
export function prCycleText(line: PrCycleLine, t: TFunction): string {
  return line.segments.map((segment) => t(segment.key, segment.params)).join(" · ");
}
