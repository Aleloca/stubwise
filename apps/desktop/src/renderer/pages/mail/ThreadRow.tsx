import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MailThreadRow, Project } from "../../data/types";
import { WorkingRing } from "../claude/conversation/parts";
import { dayLabel, dueState, whenLabel } from "./format";
import { AlertGlyph, CalendarDueGlyph, ImportantGlyph, PaperclipGlyph, PencilGlyph } from "./glyphs";

// Una conversazione nell'elenco (shape mail.md §3): 72 px, tre linee. Le
// email non hanno codice (A1): la riga comincia da chi scrive. L'importanza è
// forma, non colore (A5): glifo per l'alta, testo attenuato per la bassa. La
// scadenza è il solo colore, sempre con parola e icona.

export type ProjectRef = Pick<Project, "id" | "code" | "name">;

/** La scadenza in parole: futura, oggi (warning) o passata (critical). */
export function DueLabel({ date, long = false }: { date: string; long?: boolean }) {
  const { t, i18n } = useTranslation();
  const state = dueState(date);
  const day = dayLabel(date, i18n.language);
  if (state === "future") {
    return <span className="text-ink-muted">{t(long ? "mail.due.futureLong" : "mail.due.future", { date: day })}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${state === "today" ? "text-warning" : "text-critical"}`}>
      <CalendarDueGlyph />
      {state === "today" ? t("mail.due.today") : t("mail.due.overdue", { date: day })}
    </span>
  );
}

/** I mittenti: «Marco Bellini, Mix Cucine +2». */
export function participantsLabel(row: Pick<MailThreadRow, "participants">): string {
  const names = row.participants.map((p) => p.name || p.email);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** Progetti: il primo con codice e nome, «+1» per gli altri (tutti nel `title`). */
export function ProjectsLabel({ ids, projects }: { ids: readonly string[]; projects: ReadonlyMap<string, ProjectRef> }) {
  const known = ids.flatMap((id) => {
    const p = projects.get(id);
    return p ? [p] : [];
  });
  if (known.length === 0) return null;
  const first = known[0]!;
  return (
    <span className="flex min-w-0 shrink items-baseline gap-1" title={known.map((p) => `${p.code} ${p.name}`).join(", ")}>
      <span className="num shrink-0 font-semibold tracking-[0.02em] text-ink">{first.code}</span>
      <span className="min-w-0 truncate text-ink-muted">{first.name}</span>
      {known.length > 1 && <span className="num shrink-0 text-ink-faint">+{known.length - 1}</span>}
    </span>
  );
}

/** Il nome accessibile della riga: tutto in parole, nell'ordine in cui si legge. */
export function useRowLabel() {
  const { t, i18n } = useTranslation();
  return (row: MailThreadRow, projects: ReadonlyMap<string, ProjectRef>, draft: boolean) => {
    const parts: string[] = [];
    if (row.unread > 0) parts.push(t("mail.row.unread"));
    if (row.importance === "high") parts.push(t("mail.importance.high"));
    if (row.importance === "low") parts.push(t("mail.importance.low"));
    parts.push(participantsLabel(row));
    parts.push(row.subject || t("mail.row.noSubject"));
    const names = row.projectIds.flatMap((id) => {
      const p = projects.get(id);
      return p ? [`${p.code} ${p.name}`] : [];
    });
    if (names.length) parts.push(names.join(", "));
    if (row.dueDate) {
      const state = dueState(row.dueDate);
      const day = dayLabel(row.dueDate, i18n.language);
      parts.push(
        state === "today"
          ? t("mail.due.today")
          : state === "overdue"
            ? t("mail.due.overdue", { date: day })
            : t("mail.due.future", { date: day }),
      );
    }
    if (row.openProposals > 0) parts.push(t("mail.row.toDecideLong", { count: row.openProposals }));
    if (row.analysing) parts.push(t("mail.row.analysing"));
    if (row.failed) parts.push(t("mail.row.failed"));
    if (draft) parts.push(t("mail.row.draft"));
    parts.push(whenLabel(row.lastAt, i18n.language));
    return parts.join(" · ");
  };
}

export function ThreadRow({
  row,
  projects,
  selected,
  draft,
  label,
  onOpen,
  snippet,
  arrived = false,
}: {
  row: MailThreadRow;
  projects: ReadonlyMap<string, ProjectRef>;
  selected: boolean;
  draft: boolean;
  label: string;
  onOpen: (threadId: string) => void;
  /** Con una ricerca: il frammento con le parole trovate al posto del testo. */
  snippet?: ReactNode;
  /** Arrivata adesso (allineamento): entra in dissolvenza. */
  arrived?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const unread = row.unread > 0;
  const low = row.importance === "low";
  const strong = unread ? "font-semibold" : "font-normal";
  const tone = low ? "text-ink-muted" : "text-ink";
  return (
    <div
      role="option"
      id={`mail-row-${row.threadId}`}
      aria-selected={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      data-thread={row.threadId}
      onClick={() => onOpen(row.threadId)}
      className={`relative flex h-[72px] shrink-0 cursor-default flex-col justify-center gap-0.5 border-b border-rule px-4 outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus aria-selected:bg-ink/10 ${arrived ? "event-enter" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-md">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${unread ? "bg-ink" : "bg-transparent"}`} />
        <span className={`min-w-0 flex-1 truncate ${strong} ${tone}`}>{participantsLabel(row)}</span>
        {row.messages > 1 && <span className="num shrink-0 text-xs text-ink-faint">{row.messages}</span>}
        {row.attachments && (
          <span className="shrink-0 text-ink-muted">
            <PaperclipGlyph />
          </span>
        )}
        <span className="num shrink-0 text-xs text-ink-muted">{whenLabel(row.lastAt, i18n.language)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-4 text-md">
        {row.importance === "high" && (
          <span className="shrink-0 text-ink" title={t("mail.importance.high")}>
            <ImportantGlyph />
          </span>
        )}
        <span
          title={row.subject}
          className={`min-w-0 flex-1 truncate ${strong} ${row.subject ? tone : "text-ink-faint"}`}
        >
          {row.subject || t("mail.row.noSubject")}
        </span>
        {row.dueDate && (
          <span className="num shrink-0 text-xs">
            <DueLabel date={row.dueDate} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-4 text-xs">
        <ProjectsLabel ids={row.projectIds} projects={projects} />
        <Signal row={row} draft={draft} />
        <span className="min-w-0 flex-1 truncate text-ink-muted">{snippet ?? row.snippet}</span>
      </div>
    </div>
  );
}

/** Il segnale delle proposte e dell'analisi sulla terza linea. */
function Signal({ row, draft }: { row: MailThreadRow; draft: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {row.openProposals > 0 && (
        <span className="flex shrink-0 items-center gap-1 font-medium text-ink">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
          {t("mail.row.toDecide", { count: row.openProposals })}
        </span>
      )}
      {row.analysing && (
        <span className="flex shrink-0 items-center gap-1 text-ink-muted">
          <WorkingRing size={10} />
          {t("mail.row.analysing")}
        </span>
      )}
      {row.failed && !row.analysing && (
        <span className="flex shrink-0 items-center gap-1 text-critical">
          <AlertGlyph />
          {t("mail.row.failed")}
        </span>
      )}
      {draft && (
        <span className="flex shrink-0 items-center gap-1 text-ink-muted">
          <PencilGlyph />
          {t("mail.row.draft")}
        </span>
      )}
    </>
  );
}
