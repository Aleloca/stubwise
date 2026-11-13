import type { AiBlock } from "../claude/work.js";

// I tipi delle Automations (area 7): spostati dal prototipo
// (`apps/desktop/src/renderer/data/model.ts`) col motore puro, perché server,
// worker e app leggano lo STESSO documento (piano della fetta 1, task 0).

// --- Automations (area 7) ----------------------------------------------------

// Un flusso è un documento dichiarativo ad albero (JSON tipato): lo valida
// una funzione pura e lo interpreta un motore puro (`domain/automations`).
// Niente salti all'indietro: i cicli sono solo `forEach` e `repeatUntil`.
// Nei testi dei passi i dati si citano con `{{chiave}}` (es. `{{cliente.nome}}`).
//
// Convenzioni del motore (decisioni del controller, area 7):
// - R-J2 — un `wait` con `replyTo` scrive, a OGNI attesa, `risposta.arrivata`
//   e `risposta.testo`: con la risposta `true` e il testo, scaduto `maxDays`
//   `false` e `""`. Così una verifica successiva non rilegge mai una
//   risposta vecchia. I campi stanno in `domain/automations/triggerFields.ts`
//   (`WAIT_REPLY_FIELDS`), con quelli degli inizi interni.
// - R-J3 — le chiavi dei campi di Claude valgono per tutto il flusso, e un
//   passo successivo può ridichiararle (vince il valore più recente). Dentro
//   un `forEach`, `as` fa da prefisso alle chiavi relative dell'elemento:
//   `as: "task"` su un elenco con `of: [{ key: "titolo" }]` → `task.titolo`.
// - R-J4 — `repeatUntil` controlla `until` PRIMA di ogni giro (un «while»,
//   non un «do-while»): se è già vera, zero giri.
// - R-J5 — un percorso (`RunLogEntry.path`, `AutomationRun.cursor`) è una
//   sequenza di segmenti separati da `/`: l'indice del passo nella sua
//   lista; `then`/`else` dopo una `condition`; il nome dell'uscita dopo un
//   passo `claude`; `forEach[i]` (giro i, da 0) dopo un `forEach`;
//   `repeat[i]` o `onLimit` dopo un `repeatUntil`; `trigger` da solo per
//   l'inizio. Esempi: `"0"`; `"2/forEach[1]/0/else/0/then/0"`;
//   `"3/then/0/mancano informazioni/0"`; `"2/repeat[0]/1"`;
//   `"2/onLimit/0"`; `"trigger"`. In `validateFlow` e `availableFields` i
//   giri si scrivono `forEach[0]`/`repeat[0]` (vale per ogni giro).
// - R-J6 — il tipo di campo `boolean` (es. `risposta.arrivata`): nelle
//   condizioni si confronta con `is`/`is_not` e il valore `true`/`false`.

/** `boolean` (R-J6): nelle condizioni si confronta con `is`/`is_not` e un valore `true`/`false`. */
export type FieldType =
  | "text"
  | "number"
  | "date"
  | "email"
  | "person"
  | "list"
  | "file"
  | "boolean";

/** Un dato che i passi possono usare: dell'inizio, o prodotto da un passo precedente. */
export interface DataField {
  /** Es. "trattativa.cliente". */
  key: string;
  label: string;
  type: FieldType;
  /** Per un elenco: i campi di ogni elemento (chiavi relative all'elemento). */
  of?: DataField[];
}

export type AutomationTrigger =
  | { kind: "source"; sourceId: string; event: "deal_won" | "webhook" }
  | {
      kind: "stubwise";
      event:
        | "task_created"
        | "task_closed"
        | "request_created"
        /** Q5 = a *(M)*: una richiesta diventata task (la task vale anche come «creata»). */
        | "request_converted"
        | "milestone_reached"
        | "mail_received";
      filter?: Condition;
    }
  /** `rule`: una RRULE semplice, es. "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9". */
  | { kind: "schedule"; rule: string }
  | { kind: "manual" };

export type Operand = { ref: string } | { value: string | number | boolean | null };

/** Un gruppo (`all`/`any`) o un confronto (`left op right`); niente espressioni libere. */
export interface Condition {
  all?: Condition[];
  any?: Condition[];
  left?: Operand;
  op?: "is" | "is_not" | "contains" | "empty" | "not_empty" | "gt" | "lt";
  right?: Operand;
}

/** «Parte da solo» o «Chiede approvazione a …» (persona, ruolo nel progetto, il proprietario). */
export type Approval =
  | { mode: "auto" }
  | { mode: "ask"; who: { personId: string } | { projectRole: string } | { owner: true } };

/** Il progetto del passo: quello dell'automazione, uno fisso, o dal cliente (tabella cliente → progetto). */
export type ProjectTarget =
  | { mode: "own" }
  | {
      mode: "fixed";
      projectId: string;
      /**
       * Area 9c ([PX 5]): il progetto scelto non è più disponibile — eliminato
       * (lo scrive `purge.ts`, senza id) o, a lettura, archiviato o invisibile
       * a chi legge (`flowFor`, senza id). Il costruttore lo dice («A project
       * that's no longer available»); scegliendo un altro progetto sparisce.
       */
      unavailable?: true;
    }
  | { mode: "from_client"; clientRef: string };

/**
 * Una persona indicata da un passo: una persona scelta, il dato Persona
 * dell'evento o di un passo (`personRef`, una chiave, mai un modello né un
 * testo libero: si legge una volta sola durante l'esecuzione) o un ruolo nel
 * progetto del passo (la prima persona col ruolo, in ordine alfabetico).
 */
export type PersonTarget = { personId: string } | { personRef: string } | { projectRole: string };

export type Step =
  | {
      id: string;
      kind: "createTask";
      title: string;
      description: string;
      /** Una persona (scelta o dal dato Persona), un reparto (nessun incaricato), un ruolo nel progetto. */
      assignee: PersonTarget | { departmentId: string } | null;
      dueInDays: number | null;
      project: ProjectTarget;
      /** L'id di un passo `createMilestone` precedente. */
      milestoneRef: string | null;
      approval: Approval;
    }
  | {
      id: string;
      kind: "createMilestone";
      name: string;
      dueInDays: number | null;
      project: ProjectTarget;
      approval: Approval;
    }
  | {
      id: string;
      kind: "createRequest";
      title: string;
      description: string;
      project: ProjectTarget;
      approval: Approval;
    }
  | {
      id: string;
      kind: "sendEmail";
      /** Un modello, es. "{{cliente.email}}". */
      to: string;
      subject: string;
      body: string;
      attachRefs: string[];
      approval: Approval;
    }
  | {
      id: string;
      kind: "notify";
      /**
       * Una persona, un ruolo, o un reparto (area 10b): l'avviso va a ogni
       * membro del reparto che vede il progetto del passo, uno per persona.
       */
      who: PersonTarget | { departmentId: string };
      text: string;
      approval: Approval;
    }
  | { id: string; kind: "startAutomation"; automationId: string; approval: Approval }
  | {
      id: string;
      kind: "wait";
      /**
       * Un tempo, la risposta a un `sendEmail` (per id) o una task chiusa, col
       * massimo di giorni. `replyTo` scrive `risposta.arrivata`/`risposta.testo` (R-J2).
       */
      for:
        | { days: number }
        | { replyTo: string; maxDays: number }
        | { taskClosed: string; maxDays: number };
    }
  | {
      id: string;
      kind: "claude";
      instruction: string;
      inputs: string[];
      /** Le sole uscite ammesse (regola 2 dell'anti-obiettivo). */
      outcomes: string[];
      /** I soli campi che può compilare, col loro tipo; chiavi globali, ridichiarabili (R-J3). */
      fields: DataField[];
      /** I passi di ogni uscita; un'uscita senza ramo prosegue. */
      branches: Record<string, Step[]>;
    }
  | { id: string; kind: "condition"; when: Condition; then: Step[]; else: Step[] }
  /** `as` fa da prefisso alle chiavi relative dell'elemento (R-J3). */
  | { id: string; kind: "forEach"; list: string; as: string; steps: Step[] }
  | {
      id: string;
      kind: "repeatUntil";
      /** Controllata prima di ogni giro (R-J4). */
      until: Condition;
      /** Obbligatorio (≤ 10); finito, esce da `onLimit` («limite raggiunto»). */
      max: number;
      steps: Step[];
      onLimit: Step[];
    };

export interface AutomationFlow {
  trigger: AutomationTrigger;
  steps: Step[];
  /** Il titolo di ogni esecuzione, es. "Nuovo contratto – {{cliente.nome}}". */
  titleTemplate: string;
}

export interface AutomationVersion {
  n: number;
  flow: AutomationFlow;
  /** null = bozza. */
  publishedAt: string | null;
  publishedById: string | null;
  /**
   * Una bozza: chi l'ha salvata per ultimo, quando, e il numero del
   * salvataggio. Il costruttore salva dicendo quale `rev` ha letto; se
   * un'altra persona l'ha cambiata dopo, il salvataggio si ferma (`invalid:
   * stale`, shape builder [A 12]). Un numero e non l'ora: l'orologio del
   * prototipo è fisso.
   */
  savedAt?: string | null;
  savedById?: string | null;
  rev?: number | null;
  /**
   * R-J19: la revisione (`rev`, null per una mai salvata) provata fino in
   * fondo con una prova finita bene. Assente = mai provata. «Accendi» e
   * «Pubblica» dicono «non l'hai ancora provata» quando non coincide con
   * `rev`: ogni salvataggio dà un `rev` nuovo, quindi una modifica dopo la
   * prova la rende di nuovo non provata. È la sola traccia che una prova
   * lascia (shape automation-test [A 4], superata da R-J19).
   */
  testedRev?: number | null;
}

export interface Automation {
  id: string;
  /** `<PRJ>-A<n>` di progetto, `AUT-<n>` generale; mai riusati. */
  code: string;
  name: string;
  description: string;
  /** null = generale. */
  projectId: string | null;
  /** Chi l'ha accesa (o ne ha pubblicato l'ultima versione): gli effetti girano coi suoi permessi. */
  ownerId: string | null;
  status: "draft" | "active" | "paused";
  /** In ordine; l'ultima può essere una bozza. */
  versions: AutomationVersion[];
  createdAt: string;
  /** Chi l'ha creata (la riga di stato di una bozza: «created by»). */
  createdById?: string | null;
  /** Chi l'ha messa in pausa e quando (la riga di stato: «Paused by … on …»); si azzerano riaccendendo. */
  pausedById?: string | null;
  pausedAt?: string | null;
  /**
   * Perché è in pausa (build app): a mano, il proprietario ha perso il permesso
   * (D5), la sua casella non è più utilizzabile (area 7, F2-4). Assente da un
   * server più vecchio o nel prototipo.
   */
  pausedReason?: "manual" | "owner_lost_permission" | "mailbox_lost" | null;
  /**
   * La casella da cui partono le email, scelta da chi l'ha accesa o
   * pubblicata fra le sue collegate (shape automations.md [A 12]). Assente:
   * la casella del proprietario.
   */
  mailbox?: string | null;
  /**
   * L'id della casella di `mailbox` (area 7, F2, la build app): quella che
   * `POST …/publish` e `…/activate` ricevono come `mailboxAccountId`. Assente
   * da un server più vecchio o nel prototipo.
   */
  mailboxAccountId?: string | null;
  /**
   * Area 10b: creata da Claude per conto di `createdById` (il riquadro). Resta
   * per sempre, anche dopo l'accensione (maintainer, shape [AU 8]). Assente:
   * creata a mano.
   */
  createdVia?: "claude";
  /**
   * Area 7, F4 (F4-2 = c): il tetto del webhook in arrivo, scelto da chi
   * gestisce l'automazione. Assente da un server più vecchio o nel prototipo.
   */
  webhookLimits?: AutomationWebhookLimits;
}

/**
 * Il tetto di frequenza del webhook di un'automazione (F4-2 = c, D3):
 * `perMinute`/`perDay` sono la scelta (null = il default); `effective` è
 * ciò che vale davvero, mai oltre il massimo d'istanza.
 */
/**
 * Il valore più alto che `PATCH /api/automations/:code` accetta per il tetto
 * del webhook (oltre: 400). Il massimo d'istanza, più basso, vale comunque;
 * questo è il limite di ciò che si può SCRIVERE, uguale per server e client.
 */
export const WEBHOOK_LIMIT_CEILING = { perMinute: 1_000_000, perDay: 100_000_000 } as const;

export interface AutomationWebhookLimits {
  perMinute: number | null;
  perDay: number | null;
  defaultPerMinute: number;
  defaultPerDay: number;
  maxPerMinute: number;
  maxPerDay: number;
  effective: { perMinute: number; perDay: number };
}

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "waiting_event"
  | "waiting_project"
  | "suspended"
  | "done"
  | "failed"
  | "cancelled";
/** Una riga del registro di un'esecuzione (regola 3: tutto tracciato). */
/**
 * Una motivazione come codice e parametri (nomi propri, numeri, indirizzi):
 * l'interfaccia la traduce con `automations.reasons.<code>`, e nella prova
 * al condizionale. `reason` resta la prosa del registro.
 */
export interface ReasonCode {
  code: string;
  params?: Record<string, string | number>;
}

export interface RunLogEntry {
  at: string;
  stepId: string;
  /** Grammatica R-J5, es. "2/forEach[1]/0/then/0"; "trigger" per l'inizio. */
  path: string;
  kind: Step["kind"] | "trigger";
  /**
   * Gli esiti del motore, più quelli scritti dal livello dati sul passo al
   * cursore: `suspended` (pausa), `resumed` (riaccesa, `byId`), `cancelled`
   * («Annulla», `byId`), `retried` («Riprova», `byId`); «Salta» è `skipped`
   * con `byId`. Nessuno di questi conta come passo eseguito.
   */
  outcome:
    | "ok"
    | "skipped"
    | "failed"
    | "waiting"
    | "approved"
    | "rejected"
    | "limit"
    | "suspended"
    | "resumed"
    | "cancelled"
    | "retried";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  /** La motivazione (di Claude, o del fallimento): prosa per il registro, mai mostrata come tale. */
  reason: string | null;
  /** La motivazione come la mostra l'interfaccia, nella lingua di chi guarda (tutto tranne Claude). */
  why?: ReasonCode | null;
  /** Chi ha approvato, rifiutato, riprovato o saltato. */
  byId: string | null;
  /**
   * R-J16: solo nelle letture, per chi non è il proprietario — il testo della
   * risposta del cliente è stato tolto da questa riga (sta nella casella del
   * proprietario, shape [A 21]).
   */
  replyHidden?: boolean;
  /**
   * Area 7, F3 (C-F3-7): solo nelle letture, per chi non è il proprietario — la
   * motivazione di Claude e i suoi campi di testo sono stati tolti da questa
   * riga, perché il passo leggeva un dato di fuori (tinto) che solo lui vede.
   */
  reasonHidden?: boolean;
  /**
   * Le cose create dal passo (task, traguardo…) col loro codice. Nelle
   * letture (R-J12) una cosa in un progetto che chi guarda non vede ha
   * `code: ""`: né id né codice. Una task eliminata (area 10a) che chi
   * guarda vedeva ha `deleted: true`: si legge «task deleted», senza link.
   */
  effects: { kind: string; code: string; deleted?: true }[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** Numerata per automazione: «AUD-A1 #2». */
  n: number;
  /** La versione con cui è partita, e con cui finisce. */
  version: number;
  title: string;
  status: RunStatus;
  event: Record<string, unknown>;
  vars: Record<string, unknown>;
  /** Il percorso (R-J5) del passo corrente: per un'esecuzione in attesa, quello del passo che aspetta. */
  cursor: string | null;
  waitingUntil: string | null;
  /** Approvazione o «scegli il progetto» in attesa: chi decide e cosa vede. */
  pending: { approverIds: string[]; preview: Record<string, unknown> } | null;
  log: RunLogEntry[];
  startedAt: string;
  endedAt: string | null;
  /** Un codice macchina (es. `permission_lost`); la spiegazione sta nel `reason` del registro. */
  error: string | null;
  /** I progetti in cui ha agito (per le generali: dalla tabella cliente → progetto). */
  projectIds: string[];
  /**
   * Gli elementi dei `forEach` in corso, fissati all'ingresso
   * (`EngineState.loops`): la ripresa li rilegge da qui, mai dalle variabili.
   */
  loops?: Record<string, unknown[]>;
  /**
   * I clienti → progetti già risolti (`EngineState.projects`): un progetto
   * scelto a mano vale per tutti i passi dopo, anche dopo una ripresa.
   */
  projects?: Record<string, string>;
  /** L'esecuzione che l'ha avviata con «Avvia un'altra automazione» (catena di al massimo 3). */
  parentRunId?: string | null;
  /**
   * Review F4: l'evento viene da fuori per intero (figlia di una madre da
   * sorgente, email o supporto, o a sua volta figlia di una così): le
   * destinazioni che Claude ricava dai campi dell'inizio chiedono
   * l'approvazione (`forceApprovalForUntrusted` con `eventUntrusted`), come
   * nel worker (`event_untrusted`). Assente = no.
   */
  eventUntrusted?: boolean;
  /** Solo nelle letture (R-J13): l'evento è un'email che chi guarda non vede; la pagina lo dice. */
  mailHidden?: boolean;
  /** Da dove è partita (le ricorrenze contano solo le proprie, `dueSchedules`). */
  origin?: "manual" | "source" | "stubwise" | "schedule" | "automation";
  /** In `suspended` (pausa): lo stato a cui torna riaccendendo l'automazione. */
  suspendedFrom?: Exclude<RunStatus, "suspended" | "done" | "failed" | "cancelled">;
  /**
   * Solo nelle letture (area 9b, ruling 15): resta `running`, ferma al
   * confine di un passo di Claude per un blocco d'istanza (budget del mese,
   * coda in pausa). Riparte da sola quando il blocco cade.
   */
  aiWaiting?: AiBlock | null;
  /**
   * Solo nelle letture, con `aiWaiting` `queue_paused`: il codice del
   * progetto la cui coda è in pausa (sempre un progetto che chi guarda vede).
   */
  aiWaitingCode?: string | null;
}

export interface AutomationSource {
  id: string;
  kind: "audin" | "hubspot" | "webhook";
  name: string;
  status: "connected" | "expired" | "disconnected";
  connectedById: string;
  /** Eventi di esempio: «Simula un evento» ne fa arrivare uno, la prova li offre. */
  sampleEvents: Record<string, unknown>[];
  /** I dati che i suoi eventi portano. */
  fields: DataField[];
  /** Un webhook in arrivo: l'indirizzo a cui si manda (finto nel prototipo). */
  address?: string;
  /** Quando è stata collegata, e chi l'ha ricollegata e quando (shape sources [A 5]). */
  connectedAt?: string;
  reconnectedById?: string | null;
  reconnectedAt?: string | null;
  /** Da quando è scaduta (stato `expired`). */
  expiredAt?: string | null;
}

/** Una riga della tabella cliente → progetto (gestita da chi ha `integrations.manage`). */
export interface ClientProjectLink {
  /** Es. il dominio o l'id del cliente. */
  clientKey: string;
  clientName: string;
  projectId: string;
  /** Chi l'ha aggiunta e quando (la colonna «Added by»). */
  addedById?: string;
  addedAt?: string;
}

