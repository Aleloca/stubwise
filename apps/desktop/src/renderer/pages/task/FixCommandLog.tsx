import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationEvent } from "../../data/types";
import { CommandRows, isServerCommand } from "../claude/conversation/CommandRows";
import type { Ev } from "../claude/conversation/flow";
import { serverCheckText } from "../claude/conversation/serverCheck";
import {
  CheckGlyph,
  clock,
  CrossGlyph,
  DisclosureGlyph,
  usePersonName,
} from "../claude/conversation/parts";

// Il registro dei comandi di una correzione di server nella sezione Claude
// della task (shape server-task.md, «Registro dei comandi»): «▾ Commands on
// SRV-1 · 12», aperto mentre Claude legge o corregge e chiuso dopo; sotto,
// sempre in vista, il controllo finale in parole (lo dice il campo
// `resolved` del `work_result`, R-L3) e, se la correzione si è fermata,
// perché: chi l'ha fermata SOLO per uno Stop vero (`stoppedById`), il
// motivo in parole per ogni altra fermata.

const K = "taskDetail.server.log";

function StopLine({ phase }: { phase: Ev<"phase"> }) {
  const { t, i18n } = useTranslation();
  const name = usePersonName(phase.stoppedById);
  let text: string | null = null;
  if (phase.stoppedById) {
    text = t(`${K}.stoppedBy`, { name, time: clock(phase.at, i18n.language) });
  } else if (phase.reason && phase.reason !== "item_closed") {
    text = t(`${K}.stoppedReasons.${phase.reason}`);
  } else if (phase.outcome === "failed" || phase.outcome === "timed_out") {
    text = t(`${K}.stoppedReasons.${phase.outcome}`);
  }
  if (!text) return null;
  return <p className="text-sm text-ink-muted">{text}</p>;
}

export function FixCommandLog({
  events,
  serverCode,
  live,
}: {
  events: readonly ConversationEvent[];
  serverCode: string;
  /** Claude legge o corregge adesso: il registro si apre da solo. */
  live: boolean;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const listId = useId();
  const commands = events.filter(
    (e): e is Ev<"action"> => e.type === "action" && isServerCommand(e),
  );
  const check = events
    .filter(
      (e): e is Ev<"work_result"> =>
        e.type === "work_result" && e.kind === "server_check" && e.resolved !== undefined,
    )
    .at(-1);
  const ended = events
    .filter((e): e is Ev<"phase"> => e.type === "phase" && e.outcome !== null)
    .at(-1);
  const stopped = ended && ended.outcome !== "ok" && !check ? ended : null;
  if (commands.length === 0 && !check && !stopped) return null;
  const open = choice ?? live;

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-rule pt-1.5">
      {commands.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setChoice(!open)}
            className="-ml-1.5 flex min-h-7 items-center gap-2 self-start rounded-md px-1.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
          >
            <DisclosureGlyph open={open} />
            <span className="num">
              {t(`${K}.count`, { code: serverCode, count: commands.length })}
            </span>
          </button>
          {open && (
            <div id={listId}>
              <CommandRows actions={commands} serverCode={serverCode} />
            </div>
          )}
        </>
      )}
      {check && (
        <p
          data-server-check={check.resolved ? "resolved" : "not_resolved"}
          className="flex items-start gap-2 text-md text-ink [overflow-wrap:anywhere]"
        >
          <span className={`mt-0.5 shrink-0 ${check.resolved ? "text-positive" : "text-critical"}`}>
            {check.resolved ? <CheckGlyph size={14} /> : <CrossGlyph size={14} />}
          </span>
          {serverCheckText(check, t)}
        </p>
      )}
      {stopped && <StopLine phase={stopped} />}
    </div>
  );
}
