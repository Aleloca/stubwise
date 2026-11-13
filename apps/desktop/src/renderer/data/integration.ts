import {
  AUTOMATION_F1_AVAILABILITY,
  AUTOMATION_F2_AVAILABILITY,
  AUTOMATION_F3_AVAILABILITY,
  AUTOMATION_F4_AVAILABILITY,
  type AutomationAvailability,
} from "@stubwise/shared";
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
  // Area 4, fetta 1: la Chat fra persone (`chat`, destinazione e sezione di progetto).
  // Area 5, fetta 2: il Drive (`drive`, destinazione, sezione e feature).
  // Area 6, fetta 1: il Calendario in lettura (`calendar`) e la Posta (`mail`).
  // Area 7, fetta 1: le Automations (`automations`, destinazione, sezione e feature).
  destination: new Set(["home", "projects", "planning", "filters", "claude", "chat", "drive", "calendar", "mail", "automations"]),
  // Area 5, fetta 1: i Docs del progetto (`docs`, sezione e feature).
  // Area 8, fetta 1: la sezione Releases con le sole PR aperte (`releases-prs`).
  projectSection: new Set(["overview", "tasks", "requests", "planning", "chat", "docs", "drive", "automations", "releases"]),
  // Stati e soglie del progetto.
  // Area 8, fetta 1 (46): «Repositories» ridotta al solo blocco «Releases» (`releases-repo-settings`).
  projectSettings: new Set(["statuses", "repositories"]),
  admin: new Set(["departments"]),
  taskView: new Set(["list", "board", "timeline"]),
  feature: new Set([
    // Area 7, fetta 1: le Automations (Home, «Da decidere», ⌘K, righe d'origine).
    "automations",
    // Area 7, fetta 2: email e attese (passo «Manda email», attese, «ripeti
    // finché», inizi a orario ed «email in arrivo»), con la casella vera.
    "automations-f2",
    // Area 7, fetta 3: i passi di Claude (la prova con Claude vero dal server,
    // col costo da confermare; il budget mensile prima di ogni passo).
    "automations-f3",
    // Area 7, fetta 4: le generali, le sorgenti webhook con la tabella cliente
    // → progetto e il tetto del webhook, «avvia un'altra» (via di 46 dopo la
    // review del renderer della F4, 13 nov 2026).
    "automations-f4",
    // Area 8, fetta 1 (R-1 = a): le PR aperte, la coda, il merge in due passi,
    // «Chiedi modifiche», «Solo analisi» e le note della PR. I rilasci
    // (`releases`), gli ambienti (`environments`) e le impostazioni del
    // repository (`releases-repo-settings`) restano «in arrivo».
    "releases-prs",
    // I rilasci: elenco e dettaglio (stato derivato, run col link al
    // provider), «Fai sistemare a Claude», la Home «Rilasci». «Spiega»
    // (`releases-explain`) resta spento finché Claude non sa leggere un rilascio.
    "releases",
    // Le impostazioni di rilascio del repository (PR dei colleghi, pipeline,
    // ramo), nella sezione «Repositories» ridotta (decisione di 46).
    "releases-repo-settings",
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
    // Area 4, fetta 1: la Chat fra persone (vedi CHAT_LATER_FEATURES per le fette dopo).
    "chat",
    // Area 4, fetta 2: DM, canali privati e generali, ricerca, domande e
    // «Da decidere», «anche nel canale», task e richieste da un messaggio
    // (le citazioni non hanno un flag: c'erano già, ora si risolvono).
    "chat-dm",
    "chat-private",
    "chat-general",
    "chat-search",
    "chat-questions",
    "chat-also-in-channel",
    "chat-from-message",
    // Fetta 3: @Claude nei canali.
    "chat-claude",
    // Fetta 4: gli eventi dei progetti nei canali e gli allegati.
    "chat-events",
    "chat-attachments",
    // Area 6, fetta 1: il cassetto Google (account e caselle, comune a Posta e
    // Calendario).
    "google-account",
    // Area 6, F5b: Google Drive nel Drive dei progetti (riferimenti, cartelle
    // collegate, Togli e Nascondi, i file non disponibili), la ricerca fuori
    // dai progetti, la voce «drive» del cassetto e gli allegati come link.
    "google",
    // Area 6, fetta 1: il Calendario in LETTURA (la destinazione e il blocco
    // «Prossimi appuntamenti» della Home), con le serie.
    "calendar",
    // Area 6, fetta 4: scrivere sul Calendario (nuova riunione, rispondi,
    // modifica, sposta, elimina, il progetto a mano, la disponibilità).
    "calendar-write",
    // Area 6, F5a: le riunioni registrate (l'email di Gemini sul messaggio, il
    // riassunto e le task di una riunione, la scheda di preparazione, «Open
    // the meeting» per nota). Il Drive Google (`google`) resta della F5b.
    "meeting-notes",
    // F1.2: «Aggiorna ora» di una casella (Posta e Calendario).
    "google-sync",
    // Area 6, fetta 1: la Posta TRATTATA per conversazione, la lettura, le
    // proposte della casella, letto/non letto con Gmail.
    "mail",
    // Area 6, fetta 3: scrivere (Rispondi, Rispondi a tutti, Inoltra, Nuova,
    // le bozze di Gmail, gli allegati, Invia coi 10 s del server).
    "mail-write",
    // F3: la bozza di Claude nel compositore (lo stream dal main sul desktop).
    "mail-claude-draft",
    // Area 6, fetta 2: la classificazione nuova, cioè importanza e scadenza delle
    // conversazioni, «Importanti» e il blocco Home «Posta importante».
    "mail-importance",
    // Area 6, fetta 2: la proposta condivisa coi campi modificabili, la
    // conferma parziale e gli incaricati fuori dal progetto come Contributor.
    "mail-proposal-edit",
    "mail-contributors",
    // Area 5, fetta 1: i Docs «come oggi» (spazi, albero, pagine, manuali,
    // generazione, ricerca, chat senza streaming, grafo).
    "docs",
    // Area 5, fetta 2: il Drive dei file CARICATI «come oggi» (elenco,
    // dettaglio, ricerca per nome, caricare, eliminare, aprire, «Save to
    // Drive», le citazioni F). Google (`google`, area 6) e il contenuto (F3)
    // restano fuori.
    "drive",
  ]),
};

/**
 * Area 4, la Chat fra persone: dalla fetta 1 sono accesi la destinazione, la
 * sezione di progetto e la feature `chat` (canali di progetto e il «general»,
 * messaggi, thread, reazioni, letti, menzioni); dalla fetta 2 anche
 * `chat-dm`, `chat-private`, `chat-general`, `chat-search`,
 * `chat-questions`, `chat-also-in-channel` e `chat-from-message`; dalla
 * fetta 3 `chat-claude` (@Claude nei canali); dalla fetta 4 `chat-events`
 * (gli eventi dei progetti nei canali) e `chat-attachments` (gli allegati).
 * Sono tutti accesi: l'elenco resta per i test che li spengono uno per uno.
 */
export const CHAT_LATER_FEATURES = [
  "chat-dm",
  "chat-private",
  "chat-general",
  "chat-search",
  "chat-questions",
  "chat-also-in-channel",
  "chat-from-message",
  "chat-claude",
  "chat-events",
  "chat-attachments",
] as const;

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

/**
 * Le generali, le sorgenti e la tabella cliente → progetto (area 7, F4): nel
 * prototipo sempre, nella build app con `automations-f4`.
 */
export function generalsAvailable(): boolean {
  return !isAppBuild() || featureIntegrated("automations-f4");
}

/**
 * I passi e gli inizi delle Automations che questa build offre (area 7, per
 * fette): nella build app quelli della fetta 4 (funzione `automations-f4`;
 * senza, la 3 con `automations-f3`, la 2 con `automations-f2`, o la 1), nel
 * prototipo tutti (`undefined`). La leggono il costruttore («Coming soon») e
 * la validazione (`not_available`), così non possono dire due cose diverse.
 */
export function automationAvailability(): AutomationAvailability | undefined {
  if (!isAppBuild()) return undefined;
  if (featureIntegrated("automations-f4")) return AUTOMATION_F4_AVAILABILITY;
  if (featureIntegrated("automations-f3")) return AUTOMATION_F3_AVAILABILITY;
  return featureIntegrated("automations-f2") ? AUTOMATION_F2_AVAILABILITY : AUTOMATION_F1_AVAILABILITY;
}
