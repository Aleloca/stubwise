import type { ProjectPulseSummary } from "@stubwise/shared";

/**
 * Il "polso" di un progetto in UNA riga (fase 7, Task 10): la vista «cosa
 * aspetta me» sulla lista progetti, la stessa sintesi che l'app mobile
 * mostra da tempo (`apps/mobile/src/lib/pulse-line.ts`). Le frasi sono
 * PORTATE verbatim da lì (chiavi `mobile.projects.pulse.*` → qui
 * `projects:pulse.*`): stesso vocabolario, stessa logica di priorità.
 *
 * NON è la stessa funzione condivisa fra web e mobile: mobile passa da
 * `Reader<ProjectPulseSummary>` (apre gli enum ignoti per un client non
 * aggiornabile) e da `ColorToken` del suo tema nativo — nessuna delle due
 * cose ha senso qui, dove web e server si deployano insieme e i colori sono
 * classi Tailwind. Stessa forma del resto del twin-service pattern del
 * repo (`backlog-questions.ts`/`questions.ts`): duplicare una manciata di
 * righe pure costa meno di condividerle fra due app con requisiti diversi.
 */
export type PulseTone = "signal" | "sky" | "faint" | "ok";

/**
 * Una riga di polso pronta per il rendering: `key` è una chiave i18n SENZA
 * suffisso di pluralizzazione (`projects:pulse.*` in
 * `i18n/locales/{en,it}.json`) — è `t(key, params)` a scegliere
 * `_one`/`_other` da `params.count`. Un oggetto strutturato e non una
 * stringa già composta: la funzione resta pura (niente `useTranslation`
 * qui) e testabile senza montare React.
 */
export interface PulseLine {
  tone: PulseTone;
  key: string;
  params: Record<string, unknown>;
}

type WaitingForYouItem = ProjectPulseSummary["waitingForYou"][number];
type RunningItem = ProjectPulseSummary["running"][number];

/** Chiave i18n per UN kind di `waitingForYou`. Web non ha bisogno del
 * fallback `UNKNOWN` di mobile: server e web si deployano insieme, quindi
 * `kind` è sempre uno dei due valori dell'enum. */
function waitingKindKey(kind: WaitingForYouItem["kind"]): string {
  return kind === "question" ? "projects:pulse.waitingQuestion" : "projects:pulse.waitingPlan";
}

/**
 * Riga "aspetta te" (tono ambra): se TUTTE le voci sono dello stesso kind usa
 * il nome specifico ("domanda dell'agente" / "piano da approvare",
 * pluralizzato sul conteggio); altrimenti (kind misti) il generico
 * "decisioni" — mai un conteggio senza sostantivo.
 */
function waitingForYouLine(items: WaitingForYouItem[]): PulseLine {
  const firstKey = waitingKindKey(items[0]!.kind);
  const sameKind = items.every((item) => waitingKindKey(item.kind) === firstKey);
  const key = sameKind ? firstKey : "projects:pulse.waitingMixed";
  return { tone: "signal", key, params: { count: items.length } };
}

/**
 * Riga "sta lavorando" (tono blu): con UN solo lavoro in corso il titolo
 * entra nel testo; con più di uno, un conteggio generico — non c'è un
 * titolo solo da mostrare, e concatenarli tutti non ci starebbe nella riga.
 */
function runningLine(items: RunningItem[]): PulseLine {
  if (items.length === 1) {
    return { tone: "sky", key: "projects:pulse.runningOne", params: { title: items[0]!.title } };
  }
  return { tone: "sky", key: "projects:pulse.runningMany", params: { count: items.length } };
}

/**
 * Il "polso" di un progetto in UNA riga: la sintesi che risponde a «cosa
 * succede e chi aspetta chi».
 *
 * PRIORITÀ, in ordine, come una catena di `if` esplicita — non punteggio,
 * non ordinamento: la prima condizione vera decide, le altre non sono
 * nemmeno guardate. `aspetta te` vince SEMPRE quando `waitingForYou` non è
 * vuoto, anche se lo stesso progetto ha anche lavori `running` — una
 * decisione del viewer ferma il progetto più di un lavoro che comunque
 * prosegue da solo. Stessa priorità di `apps/mobile/src/lib/pulse-line.ts`.
 */
export function pulseLineFor(summary: ProjectPulseSummary): PulseLine {
  if (summary.waitingForYou.length > 0) return waitingForYouLine(summary.waitingForYou);
  if (summary.running.length > 0) return runningLine(summary.running);
  if (summary.idleDays >= 2) {
    return { tone: "faint", key: "projects:pulse.idle", params: { count: summary.idleDays } };
  }
  return { tone: "ok", key: "projects:pulse.ok", params: {} };
}

/** Colore-testo Tailwind per tono di polso, stesso set usato altrove
 * (`WORK_STATE_TEXT_CLASS` in `components/badges.tsx`) per coerenza visiva. */
export const PULSE_TONE_CLASS: Record<PulseTone, string> = {
  signal: "text-signal",
  sky: "text-sky-400",
  faint: "text-fg-faint",
  ok: "text-ok",
};
