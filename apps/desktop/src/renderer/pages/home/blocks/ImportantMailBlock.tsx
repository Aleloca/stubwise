import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useGoogleAccount,
  useImportantMail,
  useMailboxes,
  useProjects,
} from "../../../data/queries";
import type { MailboxView, MailThreadRow } from "../../../data/types";
import { openGoogleAccount } from "../../drive/GoogleAccountCard";
import { minutesSince, whenLabel } from "../../mail/format";
import { AlertGlyph } from "../../mail/glyphs";
import { syncPhase } from "../../mail/SyncStatus";
import { DueLabel, participantsLabel, useRowLabel, type ProjectRef } from "../../mail/ThreadRow";
import { ghostButton, smallSecondary } from "../../task/parts";
import { BlockSection, queryState, rowKeys } from "./BlockSection";

/** Quante email mostra il blocco prima di «Show all N» (shape meeting-prep.md [A 5]). */
export const IMPORTANT_MAIL_CAP = 5;

/**
 * «Important email» (shape meeting-prep.md §6): le email di importanza alta
 * che non ho ancora aperto, dalla più recente, solo fra quelle che vedo
 * (`listImportantMail`: nessuna eccezione admin). Una riga apre la
 * conversazione in Posta, che la segna letta: al ritorno non c'è più.
 * Senza account Google il blocco c'è e lo dice; scaduto, tiene le righe
 * lette l'ultima volta e chiede di ricollegare; vecchio, lo dice accanto al
 * titolo.
 */
export function ImportantMailBlock() {
  const { t } = useTranslation();
  const account = useGoogleAccount();
  const connected = !!account.data;
  const mail = useImportantMail();
  const boxes = useMailboxes();
  const projectsData = useProjects().data;
  const projects = useMemo(
    () => new Map<string, ProjectRef>((projectsData ?? []).map((p) => [p.id, p])),
    [projectsData],
  );
  const rows = mail.data ?? [];
  const title = t("home.blocks.importantMail");
  const action = (
    <Link to="/mail" className={ghostButton}>
      {t("home.mail.open")}
    </Link>
  );

  if (account.isSuccess && !connected) {
    return (
      <BlockSection title={title} action={action} state={{ status: "ready" }}>
        <NotConnected text={t("home.mail.connect")} />
      </BlockSection>
    );
  }

  const state = queryState([account, mail, boxes], {
    when: rows.length === 0 && !boxes.data?.some((b) => b.expired),
    text: t("home.mail.empty"),
    body: t("home.mail.emptyBody"),
  });
  const box = worst(boxes.data ?? []);
  const phase = box ? syncPhase(box) : "ok";
  return (
    <BlockSection
      title={title}
      count={rows.length}
      meta={phase === "stale" && box ? <UpdatedAgo at={box.syncedAt} /> : undefined}
      action={action}
      state={state}
    >
      {rows.length > 0 && (
        <ul
          aria-label={t("home.mail.list")}
          className="border-t border-rule"
          onKeyDown={rowKeys("[data-important-mail] > a")}
        >
          {rows.slice(0, IMPORTANT_MAIL_CAP).map((row) => (
            <MailRow key={row.threadId} row={row} projects={projects} />
          ))}
        </ul>
      )}
      {phase === "expired" && <ExpiredLine />}
      {rows.length > IMPORTANT_MAIL_CAP && (
        <Link
          to="/mail"
          search={{ importance: "high" } as never}
          className={`${ghostButton} mt-1 ml-2`}
        >
          {t("home.mail.showAll", { count: rows.length })}
        </Link>
      )}
    </BlockSection>
  );
}

/** La casella che sta peggio: scaduta prima di vecchia. */
function worst(boxes: readonly MailboxView[]): MailboxView | undefined {
  return (
    boxes.find((b) => syncPhase(b) === "expired") ?? boxes.find((b) => syncPhase(b) === "stale")
  );
}

/**
 * Una riga da 44px su una linea: punto «non letta» · mittente · oggetto ·
 * progetto (il primo, «+1» per gli altri) · scadenza · ora. Tutta la riga
 * apre la conversazione; il nome accessibile la dice in parole.
 */
function MailRow({
  row,
  projects,
}: {
  row: MailThreadRow;
  projects: ReadonlyMap<string, ProjectRef>;
}) {
  const { t, i18n } = useTranslation();
  const label = useRowLabel();
  const known = row.projectIds.flatMap((id) => {
    const p = projects.get(id);
    return p ? [p] : [];
  });
  return (
    <li
      data-important-mail={row.threadId}
      className="relative flex h-11 min-w-0 items-center gap-3 border-b border-rule pr-3 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />
      <span className="w-40 shrink-0 truncate text-md font-semibold text-ink">
        {participantsLabel(row)}
      </span>
      <Link
        to="/mail/$threadId"
        params={{ threadId: row.threadId }}
        aria-label={label(row, projects, false)}
        title={row.subject}
        className="min-w-0 flex-1 truncate text-md text-ink outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
      >
        {row.subject || t("mail.row.noSubject")}
      </Link>
      {known.length > 0 && (
        <span
          className="flex shrink-0 items-baseline gap-1 text-xs"
          title={known.map((p) => `${p.code} ${p.name}`).join(", ")}
        >
          <span className="num font-semibold tracking-[0.02em] text-ink">{known[0]!.code}</span>
          {known.length > 1 && <span className="num text-ink-faint">+{known.length - 1}</span>}
        </span>
      )}
      {row.dueDate && (
        <span className="shrink-0 text-xs">
          <DueLabel date={row.dueDate} />
        </span>
      )}
      <span className="num w-14 shrink-0 text-right text-xs text-ink-muted">
        {whenLabel(row.lastAt, i18n.language)}
      </span>
    </li>
  );
}

/** «Updated 12 min ago» accanto al titolo, quando la casella è vecchia. */
export function UpdatedAgo({ at }: { at: string }) {
  const { t } = useTranslation();
  const minutes = minutesSince(at);
  return (
    <span className="text-warning">
      {minutes < 60
        ? t("mail.sync.minutes", { count: minutes })
        : t("mail.sync.hours", { count: Math.floor(minutes / 60) })}
    </span>
  );
}

/** Collegamento scaduto: le righe restano, sotto una riga 12px che chiede di ricollegare. */
export function ExpiredLine() {
  const { t } = useTranslation();
  return (
    <p role="status" className="flex items-center gap-1.5 py-2 pl-4 text-xs text-critical">
      <AlertGlyph />
      {t("mail.sync.expired")} ·
      <button
        type="button"
        className="rounded-sm font-medium underline decoration-critical/40 underline-offset-2 hover:decoration-critical"
        onClick={() => openGoogleAccount()}
      >
        {t("mail.sync.reconnect")}
      </button>
    </p>
  );
}

/** Senza account Google: il blocco resta, con la frase e «Connect». */
export function NotConnected({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-t border-rule py-3 pl-4">
      <p className="min-w-0 text-md text-ink">{text}</p>
      <button type="button" className={smallSecondary} onClick={() => openGoogleAccount()}>
        {t("home.mail.connectButton")}
      </button>
    </div>
  );
}
