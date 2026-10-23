import type { TicketTab } from "./ticket-tabs";
import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import { shortDate } from "./format";
import type {
  BacklogItem,
  BacklogItemStatus,
  BacklogRisk,
  ConvertBacklogResult,
  CreateBacklogResult,
  Reader,
  TicketPriority,
  Unknown,
} from "@stubwise/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import type { PulseTone } from "./pulse-line";
import { useIsOnline } from "./inbox-mutations";
import { backlogKeys, projectsPulseKey, ticketKeys } from "./query-keys";

/**
 * I tre chip della lista (canvas `3a`): `ready` è l'unico che l'API esprime
 * direttamente (`status=ready`); `active` è l'assenza di filtro — il server
 * nasconde `converted`/`archived` di default (vedi il commento su
 * `GET /api/backlog` in `apps/server/src/routes/backlog.ts` e la stessa nota
 * in `apps/web/src/routes/backlog/index.tsx`); `all` non ha un equivalente
 * server in UNA chiamata (`status` è un valore singolo, non un elenco — il web
 * stesso non ha "un multi-stato equivalente", stessa nota) — vedi
 * {@link useBacklogList} per come si ottiene comunque un "tutti" vero.
 */
export type BacklogChip = "active" | "ready" | "all";

// `backlogKeys` vive in `./query-keys` dal 23 set 2026 (l'app non resta
// indietro): `useDecision` in `inbox-mutations.ts` deve invalidarle, e quel
// file non può importare QUESTO senza un ciclo (questo importa `useIsOnline`
// da lì). Ri-esportate perché nessun chiamante cambi import.
export { backlogKeys } from "./query-keys";

/** Etichetta i18n dello stato di una voce, in parole (canvas: Pronto / In raffinamento / Nuovo…). */
export const BACKLOG_STATUS_LABEL_KEYS: Record<BacklogItemStatus, string> = {
  new: "mobile.backlog.status.new",
  refining: "mobile.backlog.status.refining",
  ready: "mobile.backlog.status.ready",
  converted: "mobile.backlog.status.converted",
  archived: "mobile.backlog.status.archived",
};

/** Tono del pallino di stato — stessa mappatura semantica di `BACKLOG_STATUS_DOT` in `apps/web/src/components/badges.tsx`. */
export const BACKLOG_STATUS_TONE: Record<BacklogItemStatus, PulseTone> = {
  new: "signal",
  refining: "sky",
  ready: "ok",
  converted: "violet",
  archived: "faint",
};

/**
 * Etichetta e tono di uno stato letto DA `Reader<BacklogItemStatus>` (può
 * portare `Unknown` — un server più nuovo con uno stato che questa build non
 * conosce ancora, vedi `packages/shared/src/reader.ts`): mai indicizzare
 * `BACKLOG_STATUS_LABEL_KEYS`/`BACKLOG_STATUS_TONE` direttamente su un valore
 * `Reader`, sempre passare da qui. Stesso principio del fallback `unknown` di
 * `InboxCard`/`kinds.unknown` — non deve mai far crollare la UI.
 */
export function backlogStatusLabelKey(status: BacklogItemStatus | Unknown): string {
  return isUnknown(status) ? "mobile.backlog.status.unknown" : BACKLOG_STATUS_LABEL_KEYS[status];
}

export function backlogStatusTone(status: BacklogItemStatus | Unknown): PulseTone {
  return isUnknown(status) ? "faint" : BACKLOG_STATUS_TONE[status];
}

const URGENCY_LABEL_KEYS: Record<TicketPriority, string> = {
  low: "mobile.backlog.urgency.low",
  medium: "mobile.backlog.urgency.medium",
  high: "mobile.backlog.urgency.high",
  urgent: "mobile.backlog.urgency.urgent",
};

/** Frase intera "rischio {{basso|medio|alto}}" (canvas): niente interpolazione a due livelli, una chiave per valore. */
const RISK_LABEL_KEYS: Record<BacklogRisk, string> = {
  low: "mobile.backlog.meta.riskLow",
  medium: "mobile.backlog.meta.riskMedium",
  high: "mobile.backlog.meta.riskHigh",
};

/** Un segmento della riga metadati di una card: chiave i18n + eventuali parametri di interpolazione. */
export interface BacklogMetaPart {
  key: string;
  params?: Record<string, unknown>;
}

/**
 * Riga metadati di una card del backlog (canvas: "alta · E3 · rischio basso ·
 * richiesto 4 volte"), come lista di parti pure — testabile senza montare
 * React, stesso principio di `pulseLineFor` in `lib/pulse-line.ts`. Il
 * chiamante fa `parts.map(p => t(p.key, p.params)).join(" · ")`.
 *
 * Se urgenza, effort e rischio sono TUTTI assenti la voce è ancora in intake
 * (il job che li stima non è ancora arrivato): un'unica parte "da stimare",
 * mai una riga vuota o con un `·` iniziale.
 *
 * L'ultimo segmento (al più uno) segue una priorità fissa, non un elenco: chi
 * è `refining` ha sempre "in refinement ›" (il canvas lo mostra SOLO lì; era
 * "chat aperta ›" finché la chat della voce esisteva, fino al 19 ott 2026);
 * altrimenti "richiesto N volte" se la voce ha più richiedenti; altrimenti
 * "N ticket collegati" se già linkata a dei ticket; altrimenti nessun extra.
 */
export function backlogMetaParts(item: {
  status: BacklogItemStatus | Unknown;
  urgency: TicketPriority | Unknown | null;
  effort: number | null;
  risk: BacklogRisk | Unknown | null;
  requestCount: number;
  ticketCount: number;
}): BacklogMetaPart[] {
  // Un'urgenza/rischio `Unknown` (server più nuovo, valore che questa build
  // non conosce — vedi `packages/shared/src/reader.ts`) si tratta come
  // ASSENTE: mostrare il segnaposto grezzo confonderebbe l'utente più che
  // ometterlo, stesso principio di `backlogStatusLabelKey` qui sopra.
  const urgency = item.urgency !== null && !isUnknown(item.urgency) ? item.urgency : null;
  const risk = item.risk !== null && !isUnknown(item.risk) ? item.risk : null;

  if (urgency === null && item.effort === null && risk === null) {
    return [{ key: "mobile.backlog.meta.estimating" }];
  }

  const parts: BacklogMetaPart[] = [];
  if (urgency !== null) parts.push({ key: URGENCY_LABEL_KEYS[urgency] });
  if (item.effort !== null) parts.push({ key: "mobile.backlog.meta.effort", params: { value: item.effort } });
  if (risk !== null) parts.push({ key: RISK_LABEL_KEYS[risk] });

  if (item.status === "refining") {
    parts.push({ key: "mobile.backlog.meta.refining" });
  } else if (item.requestCount > 1) {
    parts.push({ key: "mobile.backlog.meta.requestCount", params: { count: item.requestCount } });
  } else if (item.ticketCount > 0) {
    parts.push({ key: "mobile.backlog.meta.ticketCount", params: { count: item.ticketCount } });
  }

  return parts;
}

/**
 * Unisce più pagine per id (dedup, l'ultima occorrenza vince) e ordina per
 * `updatedAt` decrescente — vedi il chip `"all"` in {@link useBacklogList}.
 * Esportata (non solo uso interno) perché il caso reale non è ipotetico: le 3
 * chiamate di `"all"` partono in parallelo (`Promise.all`), quindi una voce
 * che cambia stato PROPRIO in quella finestra (es. appena convertita) può
 * comparire in due risposte — dedup e ordine sono testati direttamente qui,
 * non solo indirettamente da uno screen (`backlog-mutations.test.tsx`).
 */
export function mergeBacklogPages(pages: Reader<BacklogItem>[][]): Reader<BacklogItem>[] {
  const merged = new Map<string, Reader<BacklogItem>>();
  for (const page of pages) {
    for (const item of page) merged.set(item.id, item);
  }
  return Array.from(merged.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Lista del backlog per un chip. `"ready"`/`"active"` sono UNA chiamata
 * (`status=ready` / nessun filtro). `"all"` — genuinamente "tutti gli stati",
 * `converted`/`archived` inclusi — non ha un filtro server equivalente:
 * l'implementazione fa 3 chiamate (attivi di default + `status=converted` +
 * `status=archived`) e le unisce lato client (vedi {@link mergeBacklogPages}).
 * Nessuna delle tre varianti pagina (niente "carica altro"): coerente con le
 * altre schermate mobile di questa fase (Inbox, Progetti, Lavoro), nessuna
 * delle quali implementa scroll infinito — il backlog di discovery di un
 * singolo progetto è una lista corta, non la lista ticket.
 */
export function useBacklogList(chip: BacklogChip, projectId?: string) {
  const { client } = useAuth();
  return useQuery({
    queryKey: backlogKeys.list(chip, projectId),
    queryFn: async (): Promise<Reader<BacklogItem>[]> => {
      if (!client) throw new Error("useBacklogList richiede un client autenticato");
      if (chip === "ready") {
        const page = await client.backlog.list({ projectId, status: "ready" });
        return page.items;
      }
      if (chip === "active") {
        const page = await client.backlog.list({ projectId });
        return page.items;
      }
      const [activePage, convertedPage, archivedPage] = await Promise.all([
        client.backlog.list({ projectId }),
        client.backlog.list({ projectId, status: "converted" }),
        client.backlog.list({ projectId, status: "archived" }),
      ]);
      return mergeBacklogPages([activePage.items, convertedPage.items, archivedPage.items]);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
}

/**
 * Messaggio d'errore di un'azione del backlog, dal solo `code` — stessa
 * cautela di `describeInboxError` in `lib/inbox-mutations.ts` (mai da
 * `error.message`, inglese e non contratto).
 */
export function describeBacklogError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.backlog.errors.generic");
  switch (error.code) {
    case "not_convertible":
      return t("mobile.backlog.errors.notConvertible");
    case "already_converted":
      return t("mobile.backlog.errors.alreadyConverted");
    // `not_found` generico dal 22 ott 2026 (R15); il vecchio codice per i server precedenti.
    case "not_found":
    case "backlog_item_not_found":
      return t("mobile.backlog.errors.notFound");
    default:
      return t("mobile.backlog.errors.generic");
  }
}

export interface BacklogActionMutation<TInput, TResult> {
  /**
   * `onError` facoltativo (piano C delle sessioni, Task 7): nato per le
   * domande a bottoni del backlog, tolte il 19 ott 2026 con la chat della
   * voce; resta perché costa nulla e un chiamante può volerlo.
   */
  mutate: (input: TInput, options?: { onSuccess?: (result: TResult) => void; onError?: (error: unknown) => void }) => void;
  isPending: boolean;
  /** `true` offline O in volo: stessa convenzione di `DecisionMutation` in `lib/inbox-mutations.ts`. */
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * Converte una voce `ready` in ticket (`POST /api/backlog/:id/convert`). MAI
 * ottimistica (stesso principio di `useDecision`): un 409 (`not_convertible`/
 * `already_converted`) significa che qualcun altro ha già agito sulla voce, e
 * la UI deve rifletterlo — non promettere un ticket che potrebbe non essere
 * quello vero. Sul 409 invalida `backlogKeys.all` come `usePlanDecision` fa su
 * `workKeys.all`: senza, la card resterebbe con "Procedi" ancora attivo su una
 * voce non più convertibile finché `staleTime` non scade.
 */
export function useConvertBacklogItem(): BacklogActionMutation<string, Reader<ConvertBacklogResult>> {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (id: string) => {
      if (!client) return Promise.reject(new Error("useConvertBacklogItem richiede un client autenticato"));
      return client.backlog.convert(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.all });
      // ⚠️ Questa mutazione CREA UN TICKET, e finché non lo diceva nessuna
      // vista dei ticket se ne accorgeva (22 set 2026). Non è «un'altra voce
      // in un elenco di invalidazioni da tenere aggiornato»: è la forma
      // opposta — una mutazione che dichiara UNA VOLTA cosa ha cambiato,
      // sotto il prefisso che ogni query dei ticket eredita (vedi
      // `ticketKeys`). Le altre mutazioni non devono sapere niente
      // dell'hub né di nessuna schermata.
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
      // Il POLSO (23 set 2026): `backlogReadyCount` conta le voci pronte, e
      // questa ne ha appena tolta una.
      void queryClient.invalidateQueries({ queryKey: projectsPulseKey });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        // Solo il backlog: un 409 significa che il ticket NON è nato (la
        // voce non era convertibile, o l'aveva già convertita qualcun
        // altro), quindi non c'è nessun elenco di ticket che sia diventato
        // stantio per colpa di questo tentativo.
        void queryClient.invalidateQueries({ queryKey: backlogKeys.all });
      }
    },
  });

  return {
    mutate: (id, options) => mutation.mutate(id, options),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeBacklogError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}

/** Ogni quanto si rilegge lo stato del job di intake dopo una cattura. */
export const INTAKE_POLL_MS = 3_000;
/** Oltre questo l'intake è in coda dietro altro lavoro: si smette di seguirlo (resta il refetch a mano). */
const INTAKE_FOLLOW_MAX_MS = 5 * 60_000;

/**
 * Segue il job di intake e invalida la lista quando la voce esiste davvero.
 * Vive fuori dai componenti apposta: la sheet di cattura si chiude subito dopo
 * il 202, e la voce nasce ~20 s più tardi. Un errore di rete non ferma il giro
 * (si riprova al passo dopo); `failed` sì.
 */
async function followIntake(client: StubwiseClient, queryClient: QueryClient, jobId: string): Promise<void> {
  const deadline = Date.now() + INTAKE_FOLLOW_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, INTAKE_POLL_MS));
    let status: string;
    try {
      status = (await client.backlog.job(jobId)).status;
    } catch {
      continue;
    }
    if (status === "done") {
      await queryClient.invalidateQueries({ queryKey: backlogKeys.all });
      return;
    }
    if (status === "failed") return;
  }
}

/**
 * Cattura rapida (`POST /api/backlog`, 202): NON crea la voce, accoda un job
 * `intake` — vedi il commento su `create` in
 * `packages/api-client/src/endpoints/backlog.ts`. Al successo invalida
 * `backlogKeys.all` e poi segue il job ({@link followIntake}): l'invalidazione
 * immediata arriva PRIMA che la voce esista, e senza la seconda la voce
 * compariva solo riaprendo l'app (19 ott 2026). Il chiamante mostra il toast e
 * chiude la sheet nel proprio `onSuccess`.
 */
export function useCreateBacklogItem(): BacklogActionMutation<
  { projectId: string; title: string; body: string },
  Reader<CreateBacklogResult>
> {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (input: { projectId: string; title: string; body: string }) => {
      if (!client) return Promise.reject(new Error("useCreateBacklogItem richiede un client autenticato"));
      return client.backlog.create(input);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.all });
      if (client) void followIntake(client, queryClient, result.jobId);
    },
  });

  return {
    mutate: (input, options) => mutation.mutate(input, options),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeBacklogError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}

/**
 * Naviga al Lavoro (`Main/Projects/Ticket`) di un ticket appena creato da uno
 * screen del `BacklogStack` (dopo "Procedi", o da un ticket collegato in
 * `BacklogItemScreen`). La destinazione vive in un altro TAB (`Projects`),
 * non nel `BacklogStack`: react-navigation instrada l'azione all'antenato che
 * riconosce "Main" anche se il navigator locale non lo conosce (stesso
 * bubbling che usa `useNavigation<NativeStackNavigationProp<RootStackParamList>>()`
 * in `app/navigation.tsx`) — qui si passa però l'oggetto `navigation` GIÀ
 * ricevuto dallo screen (tipizzato su `BacklogStackParamList`, che non
 * conosce "Main") invece di un secondo hook `useNavigation`, apposta: uno
 * `useNavigation()` in più pretenderebbe un `NavigationContainer` reale, e i
 * test di questi screen montano il componente da solo passando `navigation`
 * come oggetto finto (stesso pattern di `WorkScreen.test.tsx`). Il cast è
 * necessario perché il tipo locale non include "Main" — la stessa cosa che
 * TypeScript non può verificare staticamente in un albero di navigator
 * annidati senza il tipo dell'INTERO albero qui.
 */
export function navigateToTicketWork(
  navigation: { navigate: (...args: never[]) => void },
  ticketId: string,
  tab?: TicketTab,
): void {
  // `tab` facoltativo (2 ott 2026): senza, la pagina del ticket apre Stato.
  (navigation.navigate as (name: string, params?: unknown) => void)("Main", {
    screen: "Projects",
    params: { screen: "Ticket", params: tab === undefined ? { id: ticketId } : { id: ticketId, tab } },
  });
}


/**
 * Le date di una voce, per la riga d'IDENTITÀ della card (16 set 2026): non
 * stanno insieme alle stime perché rispondono a un'altra domanda — «quando» e
 * non «quanto lavoro è».
 *
 * ⚠️ L'aggiornamento compare **solo se diverso** dalla creazione. Sui dati
 * veri del maintainer le due coincidono su quasi ogni voce, e ripeterle due
 * volte di fila è rumore che occupa la riga senza dire niente: due date uguali
 * accanto sono peggio di una sola, perché fanno cercare una differenza che non
 * c'è.
 *
 * Senza ANNO sulla card, a differenza del dettaglio: `15/09` basta a
 * collocare una voce fra quelle che si stanno scorrendo, e i sei caratteri
 * risparmiati sono quelli che tengono il nome del progetto sulla stessa riga.
 */
export function backlogDatesPart(item: { createdAt: string; updatedAt: string }): BacklogMetaPart {
  const created = shortDate(item.createdAt).slice(0, 5);
  const updated = shortDate(item.updatedAt).slice(0, 5);
  return created === updated
    ? { key: "mobile.backlog.meta.created", params: { date: created } }
    : { key: "mobile.backlog.meta.createdAndUpdated", params: { created, updated } };
}

/**
 * Il documento senza l'`# H1` iniziale, quando quello ripete il TITOLO della
 * voce (16 set 2026).
 *
 * Un design doc salvato con `create_backlog_from_design` comincia quasi
 * sempre col proprio titolo, che è anche il titolo della voce: reso come
 * markdown, lo schermo lo mostrava DUE volte di fila, una in piccolo e una
 * enorme. Non è un problema di stile — è la stessa frase scritta due volte.
 *
 * Si toglie SOLO se combacia: un `# Qualcos'altro` resta dov'è, perché lì
 * l'intestazione è contenuto dell'autore e non una ripetizione. Il confronto
 * ignora spazi e maiuscole, non la punteggiatura: due titoli che differiscono
 * per una virgola sono due titoli diversi e li lasciamo entrambi.
 */
export function backlogDocumentBody(document: string, title: string): string {
  const lines = document.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return document;
  const heading = /^#\s+(.*)$/.exec(lines[first]!.trim());
  if (heading === null) return document;
  const same = heading[1]!.trim().toLowerCase() === title.trim().toLowerCase();
  return same ? lines.slice(first + 1).join("\n").replace(/^\n+/, "") : document;
}
