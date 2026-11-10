// I tipi del catalogo delle azioni di Claude (area 10a, Task 4). È una
// foglia, senza import (ruling del controller (pre-flight), P10): `model.ts`
// li legge da qui, mai da `catalog.ts`, perché un `import type` di
// `model.ts` verso il catalogo porterebbe lo store e le letture del
// registro fino al caveau dei segreti (`architecture.secrets.test.ts`).

/** Le azioni che il riquadro di Claude può produrre: l'elenco chiuso del catalogo. */
export type ClaudeActionFn =
  | "createTask"
  | "updateTask"
  | "planTask"
  | "addComment"
  | "deleteComment"
  | "createRequest"
  | "convertRequest"
  | "archiveRequest"
  | "reopenRequest"
  | "startRun"
  | "createMilestone"
  | "deleteMilestone"
  | "deleteTask"
  | "archiveProject"
  | "reopenProject"
  | "addMember"
  | "removeMember"
  | "setMemberRole"
  | "updateProjectGeneral"
  | "setProjectAi"
  | "saveProjectAutomations"
  // Le impostazioni d'istanza del 9b senza segreti (maintainer, 2 nov 2026).
  | "setModel"
  | "saveBudget"
  | "saveAutomation"
  | "setProviderEnabled"
  | "moveProvider"
  | "updateGitAccount"
  | "setDefaultReviewer"
  | "updateGoogleApp"
  | "registerPlugin"
  | "updatePluginRef"
  | "rerunSmoke"
  | "removePlugin"
  | "pauseQueue"
  | "resumeQueue"
  | "retryJob"
  | "saveStorage"
  | "setAttachments"
  | "saveWebhook"
  | "setSubscription"
  // Le bozze di automazione (area 10b): mai accenderle né pubblicarle (maintainer).
  | "createAutomation"
  | "saveAutomationDraft"
  | "deleteAutomationDraft"
  // Il filtro salvato personale (area 10b, Task 9): solo privato.
  | "saveFilter"
  | "deleteFilter"
  // La doc di prodotto (11b, Task 8): la prima versione e la bozza di
  // schermata sono A con «Undo»; l'aggiornamento da un'email o da una
  // riunione è B, perché avvisa chi segue la pagina. Gli inversi sono voci (P39).
  | "writeFirstVersion"
  | "undoFirstVersion"
  | "updateProductPage"
  | "undoProductUpdate"
  | "drawWireframe"
  | "deleteWireframe";

/** Un oggetto toccato da un'azione: il «com'era» di «Annulla» lo confronta con le scritture dopo. */
export type ObjectRef =
  | { kind: "task"; id: string }
  | { kind: "request"; id: string }
  | { kind: "milestone"; id: string }
  /** Un'automazione (area 10b): il «com'era» legge `state.objectWrites`, come richieste e traguardi. */
  | { kind: "automation"; id: string }
  /** Un filtro salvato personale (area 10b): il «com'era» legge `state.objectWrites`. */
  | { kind: "filter"; id: string }
  | { kind: "project"; id: string }
  | { kind: "member"; projectId: string; personId: string }
  | { kind: "projectSettings"; projectId: string }
  /**
   * Un'impostazione d'istanza: "budget", "model:<operation>", "automation",
   * "providers" (abilitazione e ordine), "gitAccount:<id>", "reviewer",
   * "googleApp:<id>", "plugin:<id>", "queue:<projectId>", "storage",
   * "attachments", "webhook". Il «com'era» la confronta con le voci del
   * registro sullo stesso oggetto.
   */
  | { kind: "instanceSetting"; key: string }
  | { kind: "subscription"; projectId: string; type: string }
  /**
   * 11b (P39): un blocco di una pagina di prodotto (la bozza disegnata, un
   * blocco cambiato da un aggiornamento). Il «com'era» legge le revisioni
   * della pagina che lo toccano.
   */
  | { kind: "productBlock"; pageId: string; blockId: string }
  /** 11b (P39): lo spazio Prodotto di un progetto (la prima versione): il «com'era» è il suo primo tocco. */
  | { kind: "productSpace"; projectId: string };

/** L'inverso coi valori di prima, `null` = non si annulla. */
export type CatalogInverse = { fn: ClaudeActionFn; args: Record<string, unknown> } | null;

/** Perché un'azione chiede una scheda, nell'ordine in cui lo dice (Task 4). */
export type ClassReason =
  /**
   * `personIds`: chi riceverebbe un avviso e chi chiede vede; `more`: ce n'è
   * anche fuori da quelli (mai contati). `projectId` (Task 9) solo con `more`
   * e un progetto solo: dove stanno gli altri, per «… and others who follow
   * this in AUD» (un progetto che chi chiede vede).
   */
  | { kind: "notifies"; personIds: string[]; more: boolean; projectId?: string }
  /** `event` (Task 9): quando parte, per la riga della scheda («…when a task is created»). */
  | { kind: "automation"; projectId: string; event?: "task_created" | "task_closed" }
  | { kind: "irreversible" }
  | { kind: "reauth" }
  /** Build app (chat, fetta 3): l'azione avvia il lavoro di Claude, e quello non si annulla. */
  | { kind: "startsWork" };

/** La classe calcolata di un'azione, o di un gruppo, coi motivi. */
export interface ActionClass {
  cls: "A" | "B" | "C";
  reasons: ClassReason[];
}

/**
 * Un'azione di Claude eseguita (area 10a, Task 5): una riga per azione del
 * gruppo, scritta solo a gruppo riuscito. La leggono «Annulla» (inverso,
 * oggetti, «com'era») e «Undone by» delle notifiche, a lettura.
 */
export interface ClaudeActionRecord {
  id: string;
  groupId: string;
  conversationId: string;
  /** Chi l'ha chiesta: è anche chi agisce, per i permessi e il registro. */
  personId: string;
  at: string;
  /** `nextSeq()` all'esecuzione: l'ordine del «com'era» (l'orologio è fermo, P4). */
  seq: number;
  fn: ClaudeActionFn;
  args: Record<string, unknown>;
  cls: "A" | "B" | "C";
  inverse: CatalogInverse;
  objects: ObjectRef[];
  undone: { at: string; byId: string } | null;
}

/** Perché un gruppo è occupato, come lo legge chi chiede (le forme di `taskDelete` e del 9c). */
export type ClaudeBusyReason =
  | { kind: "claude_session"; code: string | null; title?: string | null; waiting?: boolean }
  | { kind: "open_pr"; repo: string | null; number: number | null }
  | { kind: "server_fix"; serverCode: string }
  | { kind: "release_fix"; releaseCode: string }
  | { kind: "release"; code: string }
  /** Una correzione della PR ancora aperta (il server vero, «Elimina task»). */
  | { kind: "open_correction" };

/**
 * Perché una riga `executed` non è partita («Didn't run», Task 9), scritto
 * quando l'invio la rifiuta: il codice, l'azione del gruppo e il «Who?»
 * della voce (`whoAction`), col progetto solo se chi chiede lo vede (R-G5).
 */
export interface ExecutedFailure {
  code: "forbidden" | "not_found" | "invalid" | "conflict" | "busy" | "reauth_required" | "other";
  index: number;
  whoAction: string | null;
  projectId: string | null;
  projectCode: string | null;
  reasons?: ClaudeBusyReason[];
}
