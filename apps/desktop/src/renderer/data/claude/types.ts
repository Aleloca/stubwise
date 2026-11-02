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
  | "setSubscription";

/** Un oggetto toccato da un'azione: il «com'era» di «Annulla» lo confronta con le scritture dopo. */
export type ObjectRef =
  | { kind: "task"; id: string }
  | { kind: "request"; id: string }
  | { kind: "milestone"; id: string }
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
  | { kind: "subscription"; projectId: string; type: string };

/** L'inverso coi valori di prima, `null` = non si annulla. */
export type CatalogInverse = { fn: ClaudeActionFn; args: Record<string, unknown> } | null;

/** Perché un'azione chiede una scheda, nell'ordine in cui lo dice (Task 4). */
export type ClassReason =
  /** `personIds`: chi riceverebbe un avviso e chi chiede vede; `more`: ce n'è anche fuori da quelli (mai contati). */
  | { kind: "notifies"; personIds: string[]; more: boolean }
  | { kind: "automation"; projectId: string }
  | { kind: "irreversible" }
  | { kind: "reauth" };

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
