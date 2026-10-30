import type { Viewer } from "../data/types";
import type { AccessState } from "../domain/servers/sshAccess";
import { fold } from "../pages/chat/search";
import { can } from "../data/viewer";
import type { ThemePreference } from "../theme/theme";

/** Ciò che un comando può fare: navigare, cambiare tema, cambiare persona, aprire «vedi come». */
export interface CommandContext {
  /** Naviga a un percorso dell'app (senza `#`), es. `/p/AUD/tasks`. */
  navigate(path: string): void;
  setTheme(preference: ThemePreference): void;
  setPersona(personId: string): void;
  /** Codice del progetto in cui ci si trova, se si è dentro un progetto. */
  projectCode?: string;
  /** Il server aperto (`SRV-1`), se si è sul suo dettaglio. */
  serverCode?: string;
  /** Percorso della route corrente (senza ricerca): i dialoghi si aprono sopra la pagina, non al suo posto. */
  pathname: string;
  /** Apre il secondo passo «vedi come» dentro la palette. */
  openViewAs(): void;
  /** Apre il secondo passo «Open filter…» dentro la palette. */
  openFilters(): void;
  /** Apre il secondo passo «Go to channel…» dentro la palette. */
  openChannels(): void;
  /** Il testo scritto nella palette (per «Ask Claude…»). */
  query?: string;
  /** Apre «Link a Google folder» sul Drive del progetto (il dialogo lo mostra quel Drive). */
  openLinkFolder(code: string): void;
  /** Apre «New automation» (dentro un progetto, preimpostato su quello). */
  openNewAutomation(projectCode?: string): void;
}

/** Il progetto in cui si è, per i comandi che valgono solo lì. */
export interface CommandScope {
  projectId?: string;
  projectCode?: string;
  /** Il server aperto, sul suo dettaglio. */
  serverCode?: string;
  /** Lo stato dell'accesso SSH del server aperto, come lo dice il livello dati (assente finché non è letto). */
  serverAccessState?: AccessState;
}

export interface Command {
  id: string;
  labelKey: string;
  /** Scorciatoia da mostrare accanto (chiavi per `shortcutLabel`). */
  shortcut?: string[];
  /** Vero se il comando lascia la palette aperta (apre un passo successivo). */
  keepsOpen?: boolean;
  /**
   * Compare qualunque cosa sia scritta, con questa etichetta che la cita
   * («Ask Claude: “…”»): il testo non è un filtro, è il contenuto.
   */
  queryLabelKey?: string;
  run(ctx: CommandContext): void;
  when?(viewer: Viewer, scope: CommandScope): boolean;
}

function themeCommand(preference: ThemePreference): Command {
  return {
    id: `theme.${preference}`,
    labelKey: `palette.commands.theme.${preference}`,
    run: (ctx) => ctx.setTheme(preference),
  };
}

export const COMMANDS: readonly Command[] = [
  {
    id: "task.new",
    labelKey: "palette.commands.newTask",
    // Il dialogo lo monta il layout sul parametro `newTask`: la pagina resta dov'è.
    run: (ctx) =>
      ctx.navigate(
        `${ctx.pathname}?newTask=1${ctx.projectCode ? `&project=${ctx.projectCode}` : ""}`,
      ),
    // Serve `tickets.create` in almeno un progetto.
    when: (viewer) => can(viewer, "tickets.create"),
  },
  {
    id: "request.new",
    labelKey: "palette.commands.newRequest",
    // `1` = il dialogo chiede il progetto; dentro un progetto porta il suo codice.
    run: (ctx) => ctx.navigate(`${ctx.pathname}?newRequest=${ctx.projectCode ?? "1"}`),
    when: (viewer) => can(viewer, "backlog.create"),
  },
  {
    id: "chat.newMessage",
    labelKey: "palette.commands.newMessage",
    shortcut: ["mod", "N"],
    // Il dialogo lo monta il layout su `newMessage`: la pagina resta dov'è.
    run: (ctx) => ctx.navigate(`${ctx.pathname}?newMessage=1`),
  },
  {
    id: "mail.newEmail",
    labelKey: "palette.commands.newEmail",
    // La nuova email nel pannello di lettura della Posta (shape mail-compose [A 2]).
    run: (ctx) => ctx.navigate("/mail?compose=new"),
  },
  {
    id: "calendar.newMeeting",
    labelKey: "palette.commands.newMeeting",
    // «New meeting» sul Calendario, alla prima mezz'ora libera di oggi (come il bottone).
    run: (ctx) => ctx.navigate("/calendar?newMeeting=1"),
  },
  {
    id: "chat.newChannel",
    labelKey: "palette.commands.newChannel",
    // Dentro un progetto, il progetto è già scelto (se ci si possono creare canali).
    run: (ctx) => ctx.navigate(`${ctx.pathname}?newChannel=${ctx.projectCode ?? "1"}`),
    when: (viewer) => can(viewer, "chat.general.create") || can(viewer, "chat.channels.create"),
  },
  {
    id: "drive.linkFolder",
    // L'etichetta nomina il progetto in cui si è: «Link a Google folder to AUD».
    labelKey: "palette.commands.linkFolder",
    run: (ctx) => {
      if (!ctx.projectCode) return;
      ctx.navigate(`/p/${ctx.projectCode}/drive`);
      ctx.openLinkFolder(ctx.projectCode);
    },
    // Solo dentro un progetto, a chi ne gestisce il Drive.
    when: (viewer, scope) => !!scope.projectId && can(viewer, "drive.manage", scope.projectId),
  },
  {
    id: "automation.new",
    labelKey: "palette.commands.newAutomation",
    run: (ctx) => ctx.openNewAutomation(ctx.projectCode),
    // Con `automations.manage` in almeno un posto: d'istanza o in un progetto.
    when: (viewer) =>
      can(viewer, "automations.manage") ||
      Object.values(viewer.projectPermissions).some((p) =>
        (p as readonly string[]).includes("automations.manage"),
      ),
  },
  {
    // Dentro un progetto, a chi ne gestisce i widget (shape support.md §6).
    id: "support.newWidget",
    labelKey: "palette.commands.newWidget",
    run: (ctx) => {
      if (ctx.projectCode) ctx.navigate(`/p/${ctx.projectCode}/support?view=widgets&widget=new`);
    },
    when: (viewer, scope) => !!scope.projectId && can(viewer, "widget.manage", scope.projectId),
  },
  {
    // Sul dettaglio di un server, a chi gestisce gli accessi SSH (shape
    // server-access.md §4): porta alla parte «SSH access». Solo se l'accesso
    // non è già verificato (in rigenerazione le chiavi in uso lo sono):
    // altrimenti non c'è niente da collegare. R-L9: Claude non ha mai
    // `servers.ssh.manage`.
    id: "server.linkSsh",
    labelKey: "palette.commands.linkSsh",
    run: (ctx) => {
      if (ctx.projectCode && ctx.serverCode)
        ctx.navigate(`/p/${ctx.projectCode}/servers/${ctx.serverCode}?section=access`);
    },
    when: (viewer, scope) =>
      !!scope.serverCode &&
      scope.serverAccessState !== undefined &&
      scope.serverAccessState !== "verified" &&
      scope.serverAccessState !== "regenerating" &&
      can(viewer, "servers.ssh.manage"),
  },
  {
    // «Invite someone» (shape admin-people.md): People con il dialogo aperto,
    // a chi invita. R-L9: Claude non ha mai `users.invite`.
    id: "people.invite",
    labelKey: "palette.commands.inviteSomeone",
    run: (ctx) => ctx.navigate("/admin/people?invite=1"),
    when: (viewer) => can(viewer, "users.invite"),
  },
  {
    id: "chat.goTo",
    labelKey: "palette.commands.goToChannel",
    keepsOpen: true,
    run: (ctx) => ctx.openChannels(),
  },
  {
    id: "filter.open",
    labelKey: "palette.commands.openFilter",
    keepsOpen: true,
    run: (ctx) => ctx.openFilters(),
  },
  {
    id: "go.home",
    labelKey: "palette.commands.goHome",
    shortcut: ["mod", "shift", "H"],
    run: (ctx) => ctx.navigate("/home"),
  },
  {
    id: "go.projects",
    labelKey: "palette.commands.goProjects",
    run: (ctx) => ctx.navigate("/projects"),
  },
  {
    id: "prefs.notifications",
    labelKey: "palette.commands.notificationPrefs",
    run: (ctx) => ctx.navigate("/preferences/notifications"),
  },
  {
    // Dentro un progetto: la pagina con il gruppo del progetto aperto (shape alerts.md §4).
    id: "prefs.projectAlerts",
    labelKey: "palette.commands.projectAlerts",
    run: (ctx) => {
      if (ctx.projectCode) ctx.navigate(`/preferences/notifications?project=${ctx.projectCode}`);
    },
    when: (_viewer, scope) => !!scope.projectId,
  },
  {
    id: "claude.new",
    labelKey: "palette.commands.newConversation",
    run: (ctx) => ctx.navigate("/claude"),
  },
  {
    id: "claude.ask",
    labelKey: "palette.commands.askClaude",
    queryLabelKey: "palette.commands.askClaudeWith",
    // La domanda va nella casella di una conversazione nuova, da rivedere e mandare.
    run: (ctx) => {
      const q = ctx.query?.trim();
      ctx.navigate(q ? `/claude?ask=${encodeURIComponent(q)}` : "/claude");
    },
  },
  themeCommand("light"),
  themeCommand("dark"),
  themeCommand("system"),
  {
    id: "viewAs",
    labelKey: "palette.commands.viewAs",
    keepsOpen: true,
    run: (ctx) => ctx.openViewAs(),
  },
];

/** I comandi disponibili per `viewer` la cui etichetta contiene `query` (senza maiuscole). */
export function matchCommands(
  query: string,
  viewer: Viewer,
  label: (cmd: Command) => string,
  scope: CommandScope = {},
): Command[] {
  // Senza maiuscole né accenti, come la ricerca degli oggetti («tèma» trova «tema»).
  const needle = fold(query.trim());
  return COMMANDS.filter(
    (cmd) =>
      (cmd.when?.(viewer, scope) ?? true) &&
      (!needle || cmd.queryLabelKey !== undefined || fold(label(cmd)).includes(needle)),
  );
}

// --- «Who can?» (area 9a, shape admin-audit.md) -------------------------------

/** I prefissi che aprono il gruppo WHO CAN? (en, it), senza maiuscole né accenti. */
const WHO_CAN_PREFIXES = ["who can", "chi puo"];

/** Quante azioni mostra il gruppo. */
const WHO_CAN_LIMIT = 6;

/**
 * Il resto del testo dopo «who can» / «chi può» («approve plans»), già
 * piegato; `null` se il testo non comincia così. Basta l'inizio del prefisso
 * scritto per intero: «who ca» non apre il gruppo.
 */
export function whoCanRest(query: string): string | null {
  const q = fold(query.trim());
  const prefix = WHO_CAN_PREFIXES.find((p) => q === p || q.startsWith(`${p} `));
  return prefix === undefined ? null : q.slice(prefix.length).trim();
}

/** Le parole di un testo, senza la «s» del plurale inglese («plans» → «plan»). */
const stems = (text: string): string[] =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/**
 * Le azioni del catalogo il cui nome corrisponde a `rest`: ogni parola
 * scritta è l'inizio di una parola del nome (dell'azione o del permesso:
 * «approve plans» trova «approve a plan»). Senza resto, le prime.
 */
export function matchWhoCanActions<T extends { id: string }>(
  rest: string,
  actions: readonly T[],
  names: (action: T) => string[],
): T[] {
  const typed = stems(rest);
  return actions
    .filter((a) => {
      if (typed.length === 0) return true;
      const words = names(a).flatMap(stems);
      return typed.every((w) => words.some((x) => x.startsWith(w)));
    })
    .slice(0, WHO_CAN_LIMIT);
}
