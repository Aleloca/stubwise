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
}

export interface Command {
  id: string;
  labelKey: string;
  /** Scorciatoia da mostrare accanto (chiavi per `shortcutLabel`). */
  shortcut?: string[];
  /** Vero se il comando lascia la palette aperta (apre un passo successivo). */
  keepsOpen?: boolean;
  run(ctx: CommandContext): void;
  when?(viewer: Viewer): boolean;
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
): Command[] {
  const needle = query.trim().toLowerCase();
  return COMMANDS.filter(
    (cmd) => (cmd.when?.(viewer) ?? true) && (!needle || label(cmd).toLowerCase().includes(needle)),
  );
}
