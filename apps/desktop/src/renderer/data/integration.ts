import { isAppBuild } from "./build";

/**
 * Cosa è integrato col server vero in questa build (integrazione area 2,
 * fetta 1: `docs/plans/2026-11-09-integrazione-area2-task-design.md`, «Le
 * aree non ancora integrate»). Nel prototipo tutto; nella build app solo
 * l'ossatura e le Tasks. Il resto resta nella navigazione con lo stato
 * neutro «in arrivo», senza dati: nessuna sua lettura parte.
 */
export type IntegrationTarget =
  | { kind: "destination"; name: string }
  | { kind: "projectSection"; name: string }
  | { kind: "projectSettings"; name: string }
  | { kind: "admin"; name: string }
  | { kind: "taskView"; name: string }
  | { kind: "feature"; name: string };

/**
 * Le fette integrate. Una fetta nuova aggiunge qui le sue voci. Fetta 2
 * (`docs/plans/2026-11-09-integrazione-area2-fetta2-design.md`): il Planning
 * (trasversale e di progetto), La mia settimana (`/home?view=week`, la
 * funzione `my-week`: la Home a blocchi resta «in arrivo»), la Timeline e la
 * settimana pianificata (`planning-week`). Fetta 3
 * (`docs/plans/2026-11-09-integrazione-area2-fetta3-design.md`): la Home a
 * blocchi (`home`), i filtri salvati (`filters`, `saved-filters`) e i ruoli di
 * reparto (`department-home`: chi dispone la Home del reparto). I blocchi della
 * Home delle aree non integrate si spengono da soli (`registry.ts`, `area`).
 * `department-permissions` (un reparto che dà permessi di progetto) resta fuori:
 * il server non la conosce. Fetta 4
 * (`docs/plans/2026-11-09-integrazione-area2-fetta4-design.md`): Overview e
 * Requests di progetto, «Tutti i progetti» (`portfolio`); un progetto atterra
 * di nuovo sull'Overview. Refinement, task eliminate, archiviati, interruttori
 * di brief e report e pausa della coda restano delle loro aree. Area 3, fetta
 * 3a (`docs/plans/2026-11-10-integrazione-area3-claude-design.md`): la
 * destinazione `claude` con le sole sessioni di lavoro, e la funzione
 * `claude` (la sezione della task in lettura).
 */
const INTEGRATED: Record<IntegrationTarget["kind"], ReadonlySet<string>> = {
  destination: new Set(["home", "projects", "planning", "filters", "claude"]),
  projectSection: new Set(["overview", "tasks", "requests", "planning"]),
  // Stati e soglie del progetto.
  projectSettings: new Set(["statuses"]),
  admin: new Set(["departments"]),
  taskView: new Set(["list", "board", "timeline"]),
  feature: new Set([
    "notifications",
    "search",
    "task-detail",
    "new-task",
    "planning-week",
    "my-week",
    "saved-filters",
    "department-home",
    "portfolio",
    // Area 3, fetta 3a «Guardare»: le sessioni di lavoro in lettura (pagina
    // Claude, sezione Claude della task, una sessione seguita nel pannello).
    // Restano spente la chat libera (`claude-chat`, il riquadro come chat
    // compreso), le azioni (`claude-actions`, 3b) e le voci di Claude in «Da
    // decidere» (`claude-decisions`, 3b).
    "claude",
    // Fetta 3b «Agire»: le azioni della sezione, delle sessioni e del riquadro
    // (la sessione seguita), e le voci di Claude in «Da decidere».
    "claude-actions",
    "claude-decisions",
    // Fetta 3c: il refinement delle richieste («Refine with Claude»).
    "refine",
    // Chat con Claude, fetta 2: le conversazioni libere PRIVATE («Mine»,
    // «New», N) e, sotto, il riquadro. Restano spente la riga «Claude can
    // help you…» (`claude-suggestions`) e le domande della doc di prodotto
    // (`product-docs`).
    "claude-chat",
    // Fetta 3.0 della chat: «Elimina task», a mano dal menu «⋯» della task.
    "task-delete",
    // Fetta 2 della chat, il riquadro (⌘J, ⌘K «Ask Claude…») col chip del contesto.
    "claude-panel",
    // Fetta 3e: Claude fra gli assegnatari, solo nei progetti che la sua riga
    // di `/api/people` elenca (`claudeAssignableProjectIds`).
    "claude-assign",
    // «Link a person» nello standup (3e.2): sul web con la riconferma, dal
    // desktop il gesto apre il web.
    "commit-author-link",
    // Chat, fetta 3: le proposte e le azioni di Claude (A/B, «Undo»), la riga
    // di benvenuto del prototipo e i comandi «/» d'azione.
    "claude-chat-actions",
    // Chat, fetta 5: le conversazioni pubbliche («Public», «Make public»,
    // la riconferma del seguito privato) e la continuazione.
    "claude-public",
  ]),
};

export function isIntegrated(target: IntegrationTarget): boolean {
  if (!isAppBuild()) return true;
  return INTEGRATED[target.kind].has(target.name);
}

/**
 * Sul server vero una richiesta nuova passa dall'intake (può essere fusa da
 * sola in una esistente) e «Fondi in…» riscrive la destinazione col modello
 * (decisioni del maintainer, fetta 4): l'app mostra l'attesa, «Unita a R12» e
 * «Riprova». Nel prototipo creare e fondere sono immediati: lì non si mostra.
 */
export function serverIntake(): boolean {
  return isAppBuild();
}

/**
 * Sul server vero eliminare una task porta via anche il lavoro di Claude su
 * di lei (sessioni, piano, domande; decisione del maintainer del 10 nov
 * 2026): il dialogo lo dice. Nel prototipo le sessioni restano.
 */
export function serverDeletesClaudeWork(): boolean {
  return isAppBuild();
}

/**
 * Sul server vero le conversazioni con Claude inattive da 14 giorni si potano
 * (come le altre sessioni): la casella lo dice. Nel prototipo non si potano.
 */
export function chatRetentionDays(): number | null {
  return isAppBuild() ? 14 : null;
}

/** Scorciatoia per una funzione trasversale (`feature`). */
export function featureIntegrated(name: string): boolean {
  return isIntegrated({ kind: "feature", name });
}

/**
 * Dove si atterra entrando (login, primo avvio, invito, indirizzo vuoto): la
 * Home, o La mia settimana dove la Home a blocchi non è ancora integrata.
 */
export function landingSearch(): { view?: "week" } {
  return isIntegrated({ kind: "destination", name: "home" }) ? {} : { view: "week" };
}

/**
 * Il bersaglio di un indirizzo dell'app (la pagina nell'area di lavoro), con
 * la chiave del suo titolo; `null` per un indirizzo che si risolve da solo
 * (l'indice di un progetto o dell'amministrazione, che reindirizzano). La
 * query conta per `/home`: `?view=week` è La mia settimana, non la Home.
 */
export function integrationTargetOf(
  pathname: string,
  search: { view?: unknown } = {},
): { target: IntegrationTarget; titleKey: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third] = parts;
  if (!first) return null;
  if (first === "p") {
    if (!third) return null;
    if (third === "settings") {
      const name = parts[3];
      if (!name) return null;
      return { target: { kind: "projectSettings", name }, titleKey: `settings.sections.${name}` };
    }
    return { target: { kind: "projectSection", name: third }, titleKey: `project.sections.${third}` };
  }
  if (first === "admin") {
    if (!second) return null;
    return { target: { kind: "admin", name: second }, titleKey: `admin.sections.${second}` };
  }
  // La pagina di un archiviato vive con All projects, ma è dell'archivio (area 9c).
  if (first === "archived") return { target: { kind: "feature", name: "archive" }, titleKey: "nav.projects" };
  if (first === "projects") {
    // «Tutti i progetti» (il portafoglio) è della fetta 4; la colonna resta.
    return { target: { kind: "feature", name: "portfolio" }, titleKey: "nav.projects" };
  }
  if (first === "home" && search.view === "week") {
    return { target: { kind: "feature", name: "my-week" }, titleKey: "column.subviews.home.week" };
  }
  return { target: { kind: "destination", name: first }, titleKey: `nav.${first}` };
}
