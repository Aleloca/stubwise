import type { Viewer } from "../data/types";
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
}

/** Il progetto in cui si è, per i comandi che valgono solo lì. */
export interface CommandScope {
  projectId?: string;
  projectCode?: string;
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
  const needle = query.trim().toLowerCase();
  return COMMANDS.filter(
    (cmd) =>
      (cmd.when?.(viewer, scope) ?? true) &&
      (!needle || cmd.queryLabelKey !== undefined || label(cmd).toLowerCase().includes(needle)),
  );
}
