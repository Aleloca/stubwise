import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { RunLog } from "../../releases/RunLog";
import type { Ev } from "./flow";
import { CheckGlyph, clock, CrossGlyph, WorkingRing } from "./parts";

// Il registro dei comandi su un server (area 8b, shape server-task.md): una
// riga per comando, in forma di catalogo — ora, accesso in parola («read»
// tenue, «fix» d'inchiostro pieno: un comando che può tutto non sembra mai
// una lettura), il comando in monospace (intero nel `title`), l'esito a
// destra. Una riga si apre sull'uscita: le ultime 40 righe, e «Show all» la
// apre nel visore dei Rilasci, che disegna solo una finestra di righe.
// L'accesso lo legge dal campo `access` dell'azione (lo scrive il livello
// dati), mai dal nome dello strumento. ↑/↓ fra le righe, Invio apre.

type Action = Ev<"action">;

/** Le righe di un'azione che si disegnano nel registro: quelle con un accesso. */
export const isServerCommand = (a: Action): boolean => a.access !== undefined;

function CommandRow({ action }: { action: Action }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const fix = action.access === "fix";
  const command = action.input ?? action.label;
  return (
    <li className="flex min-w-0 flex-col" data-command={action.id}>
      <button
        type="button"
        data-command-row
        aria-expanded={open}
        aria-controls={outputId}
        onClick={() => setOpen((o) => !o)}
        className="grid min-h-8 w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-1.5 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5"
      >
        <time dateTime={action.at} className="num text-xs text-ink-faint">
          {clock(action.at, i18n.language)}
        </time>
        <span
          title={t(`taskDetail.server.log.${fix ? "fixLabel" : "readLabel"}`)}
          className={`w-[4.5rem] text-xs ${fix ? "font-semibold text-ink" : "text-ink-muted"}`}
        >
          {t(`taskDetail.server.log.${fix ? "fix" : "read"}`)}
        </span>
        <span title={command} className="font-code min-w-0 truncate text-xs text-ink">
          {command}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs">
          {action.state === "running" ? (
            <>
              <WorkingRing />
              <span className="text-ink-muted">{t("taskDetail.server.log.running")}</span>
            </>
          ) : action.state === "failed" ? (
            <>
              <span className="text-critical">
                <CrossGlyph size={12} />
              </span>
              <span className="font-medium text-critical">{t("taskDetail.server.log.failed")}</span>
            </>
          ) : (
            <>
              <span className="text-ink-faint">
                <CheckGlyph size={12} />
              </span>
              <span className="text-ink-muted">{t("taskDetail.server.log.ok")}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <div id={outputId} className="event-enter min-w-0 pt-1 pb-2 pl-1.5">
          {action.result ? (
            <RunLog runName={command} log={action.result} variant="command" />
          ) : (
            <p className="text-sm text-ink-muted">{t("taskDetail.server.log.noOutput")}</p>
          )}
        </div>
      )}
    </li>
  );
}

/** ↑/↓ fra le righe del registro (il fuoco resta sui bottoni delle righe). */
function moveFocus(e: KeyboardEvent<HTMLOListElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const target = e.target as HTMLElement;
  if (!target.matches("[data-command-row]")) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-command-row]")];
  const next = rows[rows.indexOf(target) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** I comandi su `serverCode`, in ordine. */
export function CommandRows({
  actions,
  serverCode,
}: {
  actions: readonly Action[];
  serverCode: string | null;
}) {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={t("taskDetail.server.log.title", { code: serverCode ?? "" })}
      onKeyDown={moveFocus}
      className="event-enter flex min-w-0 flex-col"
    >
      {actions.map((a) => (
        <CommandRow key={a.id} action={a} />
      ))}
    </ol>
  );
}
