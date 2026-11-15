import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerCommandRow } from "../../domain/servers/commands";
import type { ConversationEvent } from "../../data/types";
import { CommandRows } from "../claude/conversation/CommandRows";
import { DisclosureGlyph } from "../claude/conversation/parts";

// Il registro dei comandi della correzione, nella sezione Server della task
// (area 8, F4b, decisione del maintainer del 15 nov 2026): le letture della
// sessione e i passi approvati, dalla vista (`info.fix.commands`, nell'app
// `client.serverOps.fixCommands`). Le righe si disegnano come quelle delle
// sessioni (`CommandRows`); l'etichetta viene dall'azione e dai parametri,
// mai dal testo del modello. L'uscita è contenuto NON fidato.

type Action = Extract<ConversationEvent, { type: "action" }>;

/** L'azione di un comando in parole, al passato, coi parametri come valori. */
export function commandLabel(t: TFunction, row: ServerCommandRow): string {
  // Solo i parametri noti entrano nella frase, come valori (review F4b).
  const params = row.params as Record<string, unknown>;
  const known: Record<string, string> = {};
  for (const k of ["container", "what", "timeoutSeconds"])
    if (typeof params[k] === "string" || typeof params[k] === "number")
      known[k] = String(params[k]);
  const key = row.action.replace(".", "_");
  return t(`taskDetail.server.log.actions.${key}`, { ...known, defaultValue: row.action });
}

/** Una riga del registro come l'azione che `CommandRows` sa disegnare. */
function asAction(t: TFunction, row: ServerCommandRow): Action {
  const label = commandLabel(t, row);
  return {
    id: row.id,
    at: row.issuedAt,
    type: "action",
    tool: "server.command",
    label,
    input: label,
    ...(row.output !== null ? { result: row.output } : {}),
    state:
      row.status === "delivered"
        ? "running"
        : row.status === "cancelled" || row.status === "expired"
          ? "done"
          : row.status,
    serverCommand: {
      action: row.action,
      params: row.params,
      kind: row.kind,
      via: row.via,
      approvalId: row.approvalId,
      exitCode: row.exitCode,
      ...(row.status === "cancelled" || row.status === "expired" ? { ended: row.status } : {}),
    },
  };
}

export function ServerCommandLog({
  commands,
  serverCode,
  live,
}: {
  commands: readonly ServerCommandRow[];
  serverCode: string;
  /** La correzione legge o corregge adesso: il registro si apre da solo. */
  live: boolean;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const listId = useId();
  if (commands.length === 0) return null;
  const open = choice ?? live;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-rule pt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChoice(!open)}
        className="-ml-1.5 flex min-h-7 items-center gap-2 self-start rounded-md px-1.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        <DisclosureGlyph open={open} />
        <span className="num">
          {t("taskDetail.server.log.count", { code: serverCode, count: commands.length })}
        </span>
      </button>
      {open && (
        <div id={listId}>
          <CommandRows actions={commands.map((c) => asAction(t, c))} serverCode={serverCode} />
        </div>
      )}
    </div>
  );
}
