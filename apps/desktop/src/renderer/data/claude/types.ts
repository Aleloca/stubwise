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
