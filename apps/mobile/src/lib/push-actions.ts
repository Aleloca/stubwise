import type { StubwiseClient } from "@stubwise/api-client";
import { Linking } from "react-native";

/**
 * Categorie statiche e azioni rapide di una push (design doc §4/§6 della
 * fase 4). Ogni AZIONE è identificata da un `id` STABILE — è quell'id che
 * arriva a {@link handlePushAction} come `actionId` (il `pressActionId` di
 * notifee su un bottone, o `"open"` per un tap sul corpo della notifica) — e
 * da una chiave i18n per il titolo del bottone, risolta da chi registra le
 * categorie presso il sistema operativo (`lib/push.ts`, NON qui: questo
 * modulo resta puro e testabile senza montare notifee/i18next).
 */
export type PushActionId =
  | "answer"
  | "snooze_1h"
  | "approve"
  | "reject"
  | "relaunch"
  | "proceed"
  | "open";

export interface PushCategoryAction {
  id: PushActionId;
  titleKey: string;
}

export interface PushCategory {
  /** Id della categoria: coincide col `kind` della notifica, o `"default"`. */
  id: string;
  actions: PushCategoryAction[];
}

/**
 * Categoria di riserva per ogni `kind` non elencato in {@link PUSH_CATEGORIES}
 * (gli otto kind senza azioni rapide dichiarate — `ticket.created`,
 * `job.pr_opened`, … — e qualunque kind futuro che questa build non conosce
 * ancora): un solo bottone, "Apri", che porta alla card. Mai eseguire
 * un'azione su un kind che non sappiamo interpretare.
 */
const DEFAULT_CATEGORY: PushCategory = {
  id: "default",
  actions: [{ id: "open", titleKey: "mobile.push.actions.open" }],
};

/**
 * Le sole categorie CON azioni oltre "Apri" — design doc §6:
 *
 *  - `job.awaiting_input` → Rispondi (apre la card: la risposta è a scelta
 *    multipla O testo libero, non eseguibile a un tap) / Rimanda 1h.
 *  - `job.plan_review` → Approva (esegue) / Rifiuta… (apre: il rifiuto vuole
 *    istruzioni testuali, mai dalla notifica) / Rimanda 1h.
 *  - `project.pulse` → Procedi con la consigliata (esegue `answer` con
 *    l'opzione RACCOMANDATA, unico caso in cui una risposta parte da un tap:
 *    l'opzione è nota in anticipo, non testo libero) / Apri.
 *  - `job.failed`/`job.held` → Riprova (esegue `relaunch`) / Apri.
 */
const PUSH_CATEGORIES: Record<string, PushCategory> = {
  "job.awaiting_input": {
    id: "job.awaiting_input",
    actions: [
      { id: "answer", titleKey: "mobile.push.actions.answer" },
      { id: "snooze_1h", titleKey: "mobile.push.actions.snooze1h" },
    ],
  },
  "job.plan_review": {
    id: "job.plan_review",
    actions: [
      { id: "approve", titleKey: "mobile.push.actions.approve" },
      { id: "reject", titleKey: "mobile.push.actions.reject" },
      { id: "snooze_1h", titleKey: "mobile.push.actions.snooze1h" },
    ],
  },
  "project.pulse": {
    id: "project.pulse",
    actions: [
      { id: "proceed", titleKey: "mobile.push.actions.proceed" },
      { id: "open", titleKey: "mobile.push.actions.open" },
    ],
  },
  "job.failed": {
    id: "job.failed",
    actions: [
      { id: "relaunch", titleKey: "mobile.push.actions.retry" },
      { id: "open", titleKey: "mobile.push.actions.open" },
    ],
  },
  "job.held": {
    id: "job.held",
    actions: [
      { id: "relaunch", titleKey: "mobile.push.actions.retry" },
      { id: "open", titleKey: "mobile.push.actions.open" },
    ],
  },
};

/** Tutte le categorie da registrare presso il SO all'avvio: le 5 sopra + la di riserva. */
export const ALL_PUSH_CATEGORIES: PushCategory[] = [...Object.values(PUSH_CATEGORIES), DEFAULT_CATEGORY];

/**
 * Mappatura PURA `kind` → categoria (azioni rapide). Nessuna dipendenza da
 * notifee, i18next o React: testabile chiamandola e basta. Un kind ignoto
 * (non nel catalogo, o una stringa arbitraria) degrada alla categoria di
 * riserva — mai un errore, mai un'azione inventata.
 */
export function categoryFor(kind: string): PushCategory {
  return PUSH_CATEGORIES[kind] ?? DEFAULT_CATEGORY;
}

export interface PushActionEvent {
  /** `notification_kind` della push (payload `data.kind`, vedi `packages/notifications/src/push/payload.ts`). */
  kind: string;
  /** Riga d'inbox a cui appartiene la notifica (payload `data.notificationId`). */
  notificationId: string;
  /**
   * Id del bottone premuto (uno dei {@link PushActionId} sopra), o `"open"`
   * per un tap sul corpo della notifica (nessun bottone, apertura semplice).
   */
  actionId: string;
}

function deepLinkFor(notificationId: string): string {
  return `stubwise://inbox/${notificationId}`;
}

/** Apre l'app sulla card d'inbox: l'unica reazione a un'azione non eseguibile da qui. */
function openCard(notificationId: string): Promise<unknown> {
  return Linking.openURL(deepLinkFor(notificationId));
}

/**
 * L'opzione RACCOMANDATA della proposta del pulse, o `null` se non si riesce a
 * saperla (item non più aperto, payload non leggibile, nessuna raccomandazione).
 *
 * Il payload della push (`data`) porta solo `{ notificationId, kind, deepLink }`
 * — NON l'indice raccomandato (vedi `PushPayloadContext`/`buildPushPayload` in
 * `packages/notifications`, già deployati e fuori dallo scopo di questo task):
 * "Procedi con la consigliata" deve quindi rileggere la riga d'inbox prima di
 * poter costruire la risposta. Si riusa `client.inbox.list()` (l'inbox APERTA,
 * la stessa che alimenta la lista) invece di aggiungere una rotta "singolo
 * item": se la notifica non è più nella pagina aperta (già gestita da un
 * altro giro, o fuori dalla prima pagina) si degrada a "non lo so" — il
 * chiamante apre la card, che è comunque la risposta corretta a un'azione non
 * più offerta.
 */
async function recommendedIndexFor(client: StubwiseClient, notificationId: string): Promise<number | null> {
  const page = await client.inbox.list();
  const item = page.items.find((row) => row.id === notificationId);
  const index = item?.question?.recommendedIndex;
  return typeof index === "number" ? index : null;
}

/**
 * Esegue l'azione di una push, o apre l'app sulla card quando l'azione non è
 * eseguibile da qui — per costruzione (Rispondi, Rifiuta…, Apri) o perché il
 * server la rifiuta ora (409: qualcun altro ha deciso, il job non è più nello
 * stato giusto, la proposta non è più prendibile…).
 *
 * ⚠️ **Non chiama MAI `reject_plan` né `answer` con testo libero**: sono le
 * uniche due decisionali che vogliono un'istruzione scritta dall'utente
 * (motivazione del rifiuto, risposta libera alla domanda dell'agente), e una
 * notifica push non ha un campo di testo — un tap non può fornirla. L'unico
 * `answer` eseguito da qui è quello del pulse, con un'opzione PRE-NOTA
 * (`optionIndex`), mai testo.
 *
 * Ogni fallimento (409, errore di rete, azione sconosciuta) ha la STESSA
 * reazione visibile: aprire la card. Nessun `catch` vuoto — un tentativo che
 * fallisce in silenzio lascerebbe l'utente a credere che il tap sia stato
 * ignorato.
 */
export async function handlePushAction(event: PushActionEvent, client: StubwiseClient): Promise<void> {
  try {
    switch (event.actionId) {
      case "snooze_1h":
        await client.inbox.snooze(event.notificationId, "1h");
        return;
      case "approve":
        await client.inbox.act(event.notificationId, "approve_plan");
        return;
      case "relaunch":
        await client.inbox.act(event.notificationId, "relaunch");
        return;
      case "proceed": {
        const recommendedIndex = await recommendedIndexFor(client, event.notificationId);
        if (recommendedIndex === null) {
          await openCard(event.notificationId);
          return;
        }
        await client.inbox.answer(event.notificationId, { optionIndex: recommendedIndex });
        return;
      }
      // "answer" (Rispondi), "reject" (Rifiuta…), "open" (Apri) e qualunque
      // actionId sconosciuto: nessuno di questi si esegue da un tap, vedi il
      // docblock sopra.
      default:
        await openCard(event.notificationId);
        return;
    }
  } catch {
    // Qualunque errore (409 del server, rete assente, …) ha la stessa
    // reazione: apri la card. Non si distingue il 409 dagli altri perché il
    // rimedio è identico — l'utente vede lo stato vero della notifica invece
    // di un esito indovinato dal client.
    await openCard(event.notificationId);
  }
}
