import { Fragment, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BreakablePath } from "../../../tasks-ui/Markdown";
import type { Ev } from "./flow";
import { CheckGlyph, CrossGlyph, DisclosureGlyph, WorkingRing } from "./parts";

// Le azioni di Claude: righe sotto voce (13 px, ink-muted, 28 px), mai in
// primo piano. Le consecutive sono un gruppo «▸ 5 actions · …», chiuso di
// default e aperto mentre è in corso (con l'ultima azione visibile). Una
// riga si apre su ingresso e risultato, in blocchi monospace alti al più
// 240 px che scorrono. Un gruppo di centinaia di righe ne disegna le ultime
// `WINDOW`, con «Show N earlier» in cima.

/** Quante righe di un gruppo aperto si disegnano subito. */
export const ACTION_WINDOW = 50;

type Action = Ev<"action">;

/** Un'etichetta con dentro un percorso: il percorso va a capo dopo ogni «/». */
function Label({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) =>
        /^[\w.@-]+(\/[\w.@-]+)+\/?$/.test(part) ? (
          <BreakablePath key={i} path={part} />
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function StateMark({ state }: { state: Action["state"] }) {
  const { t } = useTranslation();
  if (state === "running") return <WorkingRing label={t("claude.conversation.actions.running")} />;
  if (state === "failed") {
    return (
      <span className="text-critical">
        <CrossGlyph size={12} />
      </span>
    );
  }
  return (
    <span className="text-ink-faint">
      <CheckGlyph size={12} />
    </span>
  );
}

export function ActionRow({ action }: { action: Action }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const detailId = useId();
  const hasDetail = action.input !== undefined || action.result !== undefined;
  const body: ReactNode = (
    <>
      <StateMark state={action.state} />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <Label text={action.label} />
        {action.state === "failed" && (
          <span className="ml-1.5 font-medium text-critical">
            {t("claude.conversation.actions.failed")}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li data-action={action.id} className="flex min-w-0 flex-col">
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 hover:text-ink"
        >
          {body}
          <DisclosureGlyph open={open} />
        </button>
      ) : (
        <div className="flex min-h-7 min-w-0 items-center gap-2 px-1.5 py-1 text-sm text-ink-muted">
          {body}
        </div>
      )}
      {open && hasDetail && (
        <div id={detailId} className="event-enter flex min-w-0 flex-col gap-1.5 pt-1 pb-2 pl-7">
          {action.input !== undefined && (
            <ActionBlock
              label={t("claude.conversation.actions.input")}
              text={action.input}
              all={all}
            />
          )}
          {action.result !== undefined && (
            <ActionBlock
              label={t("claude.conversation.actions.result")}
              text={action.result}
              all={all}
            />
          )}
          {action.truncated && !all && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="-ml-1.5 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
            >
              {t("claude.conversation.actions.showAll")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ActionBlock({ label, text, all }: { label: string; text: string; all: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-ink-faint">{label}</span>
      <pre
        tabIndex={0}
        aria-label={label}
        className={`font-code max-w-full min-w-0 overflow-auto rounded-md bg-ink/5 px-2.5 py-2 whitespace-pre text-ink-muted ${all ? "" : "max-h-[240px]"}`}
      >
        {text}
      </pre>
    </div>
  );
}

/**
 * Le azioni consecutive: una riga sola se è una, altrimenti un gruppo.
 * `compact` (pannello stretto): il gruppo resta chiuso anche in corso.
 */
export function ActionRows({ actions, compact = false }: { actions: Action[]; compact?: boolean }) {
  const { t } = useTranslation();
  const running = actions.some((a) => a.state === "running");
  const [choice, setChoice] = useState<boolean | null>(null);
  const [shown, setShown] = useState(ACTION_WINDOW);
  const listId = useId();
  const open = choice ?? (running && !compact);

  if (actions.length === 1) {
    return (
      <ul className="event-enter flex min-w-0 flex-col">
        <ActionRow action={actions[0]!} />
      </ul>
    );
  }

  const failed = actions.filter((a) => a.state === "failed").length;
  const last = actions.at(-1)!;
  const summary = running
    ? last.label
    : actions
        .slice(0, 2)
        .map((a) => a.label)
        .join(", ") + (actions.length > 2 ? ", …" : "");
  const hidden = Math.max(0, actions.length - shown);

  return (
    <div className="event-enter flex min-w-0 flex-col" data-action-group={actions[0]!.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChoice(!open)}
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 hover:text-ink"
      >
        {running ? <WorkingRing /> : <DisclosureGlyph open={open} />}
        <span className="num shrink-0 font-medium text-ink">
          {t("claude.conversation.actions.count", { count: actions.length })}
        </span>
        {failed > 0 && (
          <span className="shrink-0 font-medium text-critical">
            {t("claude.conversation.actions.failedCount", { count: failed })}
          </span>
        )}
        <span aria-hidden="true">·</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && (
        <ul id={listId} className="flex min-w-0 flex-col border-l border-rule pl-2 ml-3">
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShown((n) => n + ACTION_WINDOW)}
                className="rounded-md px-1.5 py-1 text-xs font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
              >
                {t("claude.conversation.actions.showEarlier", { count: hidden })}
              </button>
            </li>
          )}
          {actions.slice(hidden).map((a) => (
            <ActionRow key={a.id} action={a} />
          ))}
        </ul>
      )}
    </div>
  );
}
