import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SECTIONS, APP_ROUTES, PROJECT_SECTIONS, PROJECT_SETTINGS_SECTIONS } from "./routes";
import { AUTOMATION_F4_AVAILABILITY } from "@stubwise/shared";
import {
  CHAT_LATER_FEATURES,
  automationAvailability,
  generalsAvailable,
  integrationTargetOf,
  isIntegrated,
  landingSearch,
  type IntegrationTarget,
} from "./integration";

afterEach(() => vi.unstubAllEnvs());

const ALL: IntegrationTarget[] = [
  ...APP_ROUTES.map((name) => ({ kind: "destination", name }) as const),
  ...PROJECT_SECTIONS.map((s) => ({ kind: "projectSection", name: s.id }) as const),
  ...PROJECT_SETTINGS_SECTIONS.map((s) => ({ kind: "projectSettings", name: s.id }) as const),
  ...ADMIN_SECTIONS.map((s) => ({ kind: "admin", name: s.id }) as const),
  ...(["list", "board", "timeline"] as const).map((name) => ({ kind: "taskView", name }) as const),
  ...(
    [
      "notifications",
      "search",
      "task-detail",
      "new-task",
      "view-as",
      "claude-panel",
      "claude-assign",
      "commit-author-link",
      "planning-week",
      "my-week",
      "saved-filters",
      "department-home",
      "department-permissions",
      "portfolio",
      "refine",
      "claude",
      "claude-chat",
      "claude-actions",
      "claude-decisions",
      "claude-public",
      "claude-suggestions",
      "claude-chat-actions",
      "product-docs",
      "task-delete",
      "chat",
      ...CHAT_LATER_FEATURES,
      "docs",
      "drive",
      "google",
      "google-account",
      "calendar",
      "calendar-write",
      "google-sync",
      "meeting-notes",
      "mail",
      "mail-write",
      "mail-importance",
      "mail-waiting",
      "mail-proposal-edit",
      "mail-contributors",
      "mail-claude-draft",
      "automations",
      "automations-f2",
      "automations-f3",
      "automations-f4",
      "releases-prs",
      "releases",
      "releases-repo-settings",
      "releases-explain",
      "support",
      "support-widgets",
      "support-search",
      "support-identity",
      "prefs-account",
      "prefs-security",
      "prefs-tokens",
      "prefs-claude-code",
      "prefs-look",
      "prefs-mailboxes",
      "notification-restore",
      "servers-monitor",
      "servers-write",
      "servers-ssh",
      "servers",
      "servers-analysis",
      "servers-search",
      "servers-create-in-env",
      "environments",
      "environment-containers",
      "servers-analysis-limits",
      // Area 9, F3: le schede della voce AI, una funzione ciascuna.
      "ai-providers",
      "ai-models",
      "ai-automation",
      "ai-budget",
      "ai-usage",
    ] as const
  ).map((name) => ({ kind: "feature", name }) as const),
];

const key = (t: IntegrationTarget) => `${t.kind}:${t.name}`;

describe("isIntegrated", () => {
  it("nel prototipo è tutto integrato", () => {
    expect(ALL.filter((t) => !isIntegrated(t))).toEqual([]);
  });

  it("nella build app l'ossatura, le Tasks (fetta 1), Planning e La mia settimana (fetta 2), Home e filtri (fetta 3), Overview, Requests e Tutti i progetti (fetta 4), le sessioni di lavoro di Claude in lettura (area 3, 3a)", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(ALL.filter(isIntegrated).map(key).sort()).toEqual(
      [
        // Area 7, fetta 1: le Automations.
        "destination:automations",
        "projectSection:automations",
        "feature:automations",
        // Area 7, fetta 2: email e attese.
        "feature:automations-f2",
        // Area 7, fetta 3: i passi di Claude.
        "feature:automations-f3",
        // Area 7, fetta 4: generali, sorgenti webhook, «avvia un'altra».
        "feature:automations-f4",
        // Area 8, fetta 1: le PR aperte (la sezione Releases, senza rilasci né ambienti).
        "projectSection:releases",
        "feature:releases-prs",
        "feature:releases",
        "feature:releases-repo-settings",
        "feature:releases-explain",
        // Area 8, fetta 3: Support (letture e scritture) e i widget; bozza e
        // ricerca senza rotta, «Clienti in attesa» spento (fonte da definire).
        "projectSection:support",
        "feature:support",
        "feature:support-widgets",
        // API per i siti (S6): l'identità dei clienti del widget.
        "feature:support-identity",
        // Area 9, F1, R4a: Preferenze → Account (le caselle Google no: stanno nel cassetto).
        "feature:prefs-account",
        // Area 9, F1, R4b: Preferenze → Security.
        "feature:prefs-security",
        // Area 9, F1, R4c e R4d: Tokens, Claude Code, Language & theme.
        "feature:prefs-tokens",
        "feature:prefs-claude-code",
        "feature:prefs-look",
        // Area 9, F1, R10: «Restore» e «Move to New» dell'Inbox.
        "feature:notification-restore",
        // Area 8, F4a: i Server in sola lettura; scritture, SSH, analisi e ricerca spente.
        "projectSection:servers",
        "admin:servers",
        "feature:servers-monitor",
        "feature:servers-write",
        "feature:servers-create-in-env",
        "feature:environments",
        // Area 8, F4b: le analisi lette sul server e i container degli ambienti;
        // i tetti (Amministrazione → AI non è ancora integrata), l'SSH e la ricerca no.
        "feature:servers-analysis",
        "feature:servers-ssh",
        "feature:servers",
        "feature:environment-containers",
        "destination:projects",
        "projectSection:tasks",
        "projectSettings:statuses",
        // Area 9, F1, R8: Members.
        "projectSettings:members",
        // Area 9, F2: il registro delle modifiche.
        "projectSettings:changelog",
        // Area 8, fetta 1: «Repositories» ridotta al blocco «Releases».
        "projectSettings:repositories",
        "admin:departments",
        // Area 9, F1, R9: «Chi può farlo?».
        "admin:who-can",
        // Area 9, F1, R7: People e Roles.
        "admin:people",
        "admin:roles",
        // Area 9, F2: il registro delle modifiche.
        "admin:changelog",
        // Area 9, F3: i webhook in uscita.
        "admin:webhooks",
        // Area 9, F3: la voce AI, scheda per scheda (le schede in \`feature\`).
        "admin:ai",
        "admin:google",
        "admin:git-accounts",
        "admin:plugins",
        "admin:storage",
        "feature:ai-automation",
        "feature:ai-providers",
        "feature:ai-models",
        "taskView:list",
        "taskView:board",
        "feature:notifications",
        "feature:search",
        "feature:task-detail",
        "feature:new-task",
        "destination:planning",
        "projectSection:planning",
        "taskView:timeline",
        "feature:planning-week",
        "feature:my-week",
        "destination:home",
        "destination:filters",
        "feature:saved-filters",
        "feature:department-home",
        "projectSection:overview",
        "projectSection:requests",
        "feature:calendar-write",
        // Area 6, F5b: Google Drive nel Drive dei progetti.
        "feature:google",
        // Area 6, F5a: le riunioni registrate.
        "feature:meeting-notes",
        "feature:portfolio",
        // Area 3, fetta 3a: la chat libera, le azioni e «Da decidere» restano fuori.
        "destination:claude",
        "feature:claude",
        // Fetta 3b: azioni e «Da decidere».
        "feature:claude-actions",
        "feature:claude-decisions",
        // Fetta 3c: il refinement.
        "feature:refine",
        // Chat con Claude, fetta 2: le conversazioni private; pubbliche,
        // suggerimenti, azioni in chat e riquadro restano fuori.
        "feature:claude-chat",
        "feature:claude-panel",
        // Fetta 3e: Claude assegnabile.
        "feature:claude-assign",
        "feature:commit-author-link",
        "feature:claude-chat-actions",
        // Fetta 5 della chat: le pubbliche e la continuazione.
        "feature:claude-public",
        // Fetta 3.0 della chat: «Elimina task».
        "feature:task-delete",
        // Area 4, fetta 1: la Chat fra persone (le fette dopo restano spente).
        "destination:chat",
        "projectSection:chat",
        // Area 5, fetta 1: i Docs.
        "projectSection:docs",
        "feature:docs",
        // Area 5, fetta 2: il Drive dei caricati (Google e contenuto restano fuori).
        "destination:drive",
        "projectSection:drive",
        "feature:drive",
        "feature:chat",
        // Area 4, fetta 2: DM, privati, generali, ricerca, domande, «anche nel canale», da un messaggio.
        "feature:chat-dm",
        "feature:chat-private",
        "feature:chat-general",
        "feature:chat-search",
        "feature:chat-questions",
        "feature:chat-also-in-channel",
        "feature:chat-from-message",
        // Area 4, fetta 3: @Claude nei canali.
        "feature:chat-claude",
        // Area 4, fetta 4: gli eventi dei progetti e gli allegati.
        "feature:chat-events",
        "feature:chat-attachments",
        // Area 6, fetta 1: il cassetto Google (account e caselle), separato dal Drive Google (`google`, F5).
        "feature:google-account",
        // Area 6, fetta 1: il Calendario in lettura (scrivere e le note di riunione restano spenti), «Aggiorna ora» (F1.2).
        "destination:calendar",
        "feature:calendar",
        "feature:google-sync",
        // Area 6, fetta 1: la Posta in lettura (scrivere, importanza e campi delle proposte restano spenti).
        "destination:mail",
        "feature:mail",
        // Area 6, fetta 2: importanza, «Importanti» e «Posta importante».
        "feature:mail-importance",
        "feature:mail-waiting",
        "feature:mail-proposal-edit",
        "feature:mail-contributors",
        "feature:mail-write",
        "feature:mail-claude-draft",
      ].sort(),
    );
  });

  it("/home?view=week è La mia settimana, /home la Home", () => {
    expect(integrationTargetOf("/home", { view: "week" })?.target).toEqual({ kind: "feature", name: "my-week" });
    expect(integrationTargetOf("/home")?.target).toEqual({ kind: "destination", name: "home" });
  });

  it("dalla fetta 3 si atterra sulla Home anche nella build app", () => {
    expect(landingSearch()).toEqual({});
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(landingSearch()).toEqual({});
  });

  it("le Automations della build app hanno il perimetro della F4 (`automations-f4` accesa)", () => {
    expect(automationAvailability()).toBeUndefined();
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(isIntegrated({ kind: "feature", name: "automations-f2" })).toBe(true);
    expect(isIntegrated({ kind: "feature", name: "automations-f3" })).toBe(true);
    expect(isIntegrated({ kind: "feature", name: "automations-f4" })).toBe(true);
    expect(automationAvailability()).toBe(AUTOMATION_F4_AVAILABILITY);
  });

  it("le generali e le sorgenti: nel prototipo e nella build app (`automations-f4` accesa)", () => {
    expect(generalsAvailable()).toBe(true);
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(generalsAvailable()).toBe(true);
  });
});

