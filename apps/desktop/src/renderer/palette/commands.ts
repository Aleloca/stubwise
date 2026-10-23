import type { Viewer } from "../data/types";
import type { ThemePreference } from "../theme/theme";

/** Ciò che un comando può fare: navigare, cambiare tema, cambiare persona, aprire «vedi come». */
export interface CommandContext {
  /** Naviga a un percorso dell'app (senza `#`), es. `/p/AUD/tasks`. */
  navigate(path: string): void;
  setTheme(preference: ThemePreference): void;
  setPersona(personId: string): void;
  /** Codice del progetto in cui ci si trova, se si è dentro un progetto. */
  projectCode?: string;
  /** Apre il secondo passo «vedi come» dentro la palette. */
  openViewAs(): void;
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
    // Le pagine delle task non esistono ancora: si apre il segnaposto giusto.
    run: (ctx) => ctx.navigate(ctx.projectCode ? `/p/${ctx.projectCode}/tasks` : "/home"),
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
