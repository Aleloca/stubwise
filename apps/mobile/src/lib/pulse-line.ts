import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";
import type { ColorToken } from "../theme/tokens";

/**
 * I toni del polso — sottoinsieme di `ColorToken` che il canvas usa per la
 * riga di polso, più `"violet"`: NON usato da `pulseLineFor` qui sotto
 * (nessuna riga di polso lo produce), ma dal Task 17 in poi anche
 * `PulseIndicator` (il componente dot+testo colorato che questo tipo
 * vincola) rende lo stato `converted` di una voce del backlog — vedi
 * `BACKLOG_STATUS_TONE` in `lib/backlog-mutations.ts`, stesso riuso già
 * praticato da `WorkingPill` per lo stato "sta lavorando" di un job.
 */
export type PulseTone = Extract<ColorToken, "signal" | "sky" | "faint" | "ok" | "violet">;

/**
 * Una riga di polso pronta per il rendering: `key` è una chiave i18n
 * SENZA suffisso di pluralizzazione (`mobile/projects/pulse/*` in
 * `i18n/{it,en}.json`) — è `t(key, params)` a scegliere `_one`/`_other` da
 * `params.count`, stesso pattern di `mobile.inbox.pulse.idle` — e `params`
 * gli argomenti da interpolare. Un oggetto strutturato e non una stringa già
 * composta: così la funzione resta pura (niente `useTranslation` qui) e
 * testabile senza montare React — il chiamante (`PulseRow`, l'header del
 * dettaglio) fa `t(line.key, line.params)`.
 */
export interface PulseLine {
  tone: PulseTone;
  key: string;
  params: Record<string, unknown>;
}

type Summary = Reader<ProjectPulseSummary>;
type WaitingForYouItem = Summary["waitingForYou"][number];
type RunningItem = Summary["running"][number];

/**
 * Chiave i18n per UN kind di `waitingForYou`, o `null` se non riconosciuto —
 * il caso `UNKNOWN` di `Reader<PulseWaitingKind>` (server più nuovo di questa
 * build): non deve far crollare la riga, degrada al testo generico
 * `waitingMixed` più sotto invece di lanciare o mostrare un segnaposto crudo.
 */
function waitingKindKey(kind: WaitingForYouItem["kind"]): string | null {
  if (isUnknown(kind)) return null;
  if (kind === "question") return "mobile.projects.pulse.waitingQuestion";
  if (kind === "plan_approval") return "mobile.projects.pulse.waitingPlan";
  return null;
}

/**
 * Riga "aspetta te" (tono ambra): se TUTTE le voci sono dello stesso kind
 * riconosciuto usa il nome specifico ("domanda dell'agente" / "piano da
 * approvare", pluralizzato sul conteggio); altrimenti (kind misti, o un kind
 * ignoto) il generico "decisioni" — mai un conteggio senza sostantivo, mai un
 * kind grezzo mostrato all'utente.
 */
function waitingForYouLine(items: WaitingForYouItem[]): PulseLine {
  const firstKey = waitingKindKey(items[0]!.kind);
  const sameKind = firstKey !== null && items.every((item) => waitingKindKey(item.kind) === firstKey);
  const key = sameKind ? firstKey : "mobile.projects.pulse.waitingMixed";
  return { tone: "signal", key, params: { count: items.length } };
}

/**
 * Riga "sta lavorando" (tono blu): con UN solo lavoro in corso il titolo
 * entra nel testo (com'è nel canvas, "sta lavorando — Export CSV degli
 * ordini"); con più di uno, un conteggio generico — non c'è un titolo solo
 * da mostrare, e concatenarli tutti non ci starebbe nella riga di polso.
 */
function runningLine(items: RunningItem[]): PulseLine {
  if (items.length === 1) {
    return { tone: "sky", key: "mobile.projects.pulse.runningOne", params: { title: items[0]!.title } };
  }
  return { tone: "sky", key: "mobile.projects.pulse.runningMany", params: { count: items.length } };
}

/**
 * Il "polso" di un progetto in UNA riga (canvas `2a`/`2b`): la sintesi che
 * risponde a «cosa succede e chi aspetta chi», usata sia dalla riga di lista
 * (`PulseRow`) sia dall'intestazione del dettaglio.
 *
 * PRIORITÀ, in ordine, come una catena di `if` esplicita — non punteggio,
 * non ordinamento: la prima condizione vera decide, le altre non sono nemmeno
 * guardate. `aspetta te` vince SEMPRE quando `waitingForYou` non è vuoto,
 * anche se lo stesso progetto ha anche lavori `running` — una decisione del
 * viewer ferma il progetto più di un lavoro che comunque prosegue da solo.
 *
 * `viewerId` non entra nella scelta del ramo: `summary.waitingForYou` arriva
 * dal server GIÀ filtrato per il viewer che ha fatto la richiesta
 * (`GET /api/projects/pulse`, vedi il commento sullo schema in
 * `@stubwise/shared`) — non c'è nulla da filtrare di nuovo qui. Il parametro
 * resta nella firma per rendere esplicito, in ogni punto di chiamata, DI CHI
 * è il polso che si sta leggendo (lo stesso principio di `sectionize(items,
 * {role})` in `lib/inbox-sections.ts`), e per lasciare spazio a una futura
 * distinzione (es. "il TUO lavoro sta girando" vs "gira il lavoro di un
 * altro") che lo schema di oggi non porta ancora.
 */
export function pulseLineFor(summary: Summary, viewerId: string): PulseLine {
  void viewerId;

  if (summary.waitingForYou.length > 0) return waitingForYouLine(summary.waitingForYou);
  if (summary.running.length > 0) return runningLine(summary.running);
  if (summary.idleDays >= 2) return { tone: "faint", key: "mobile.projects.pulse.idle", params: { count: summary.idleDays } };
  return { tone: "ok", key: "mobile.projects.pulse.ok", params: {} };
}
