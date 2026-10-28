import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationDetail as Detail, AutomationRow } from "../../data/types";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { shortDate } from "./format";
import { MoreGlyph } from "./glyphs";
import { AutomationStatusWord, codeClass, textLink, useNames } from "./shared";

// La testata del dettaglio (vedi `AutomationDetail.tsx`): riga di stato in
// prosa, descrizione e azioni.

function StatusLine({ a }: { a: AutomationRow }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const owner = names.person(a.ownerId);
  // «‖ Paused by Laura Bianchi on Oct 20 · 1 run suspended» / «○ Draft · never turned on · created by Paolo Neri».
  const text =
    a.status === "active"
      ? t("automations.detail.statusActive", {
          n: live?.n ?? 1,
          owner,
          date: shortDate(live?.publishedAt ?? a.createdAt, i18n.language),
        })
      : a.status === "paused"
        ? a.pausedById && a.pausedAt
          ? t("automations.detail.statusPausedBy", {
              who: names.person(a.pausedById),
              date: shortDate(a.pausedAt, i18n.language),
              count: a.openRuns,
            })
          : t("automations.detail.statusPaused", { owner, count: a.openRuns })
        : a.createdById
          ? t("automations.detail.statusDraftBy", {
              who: names.person(a.createdById),
              date: shortDate(a.createdAt, i18n.language),
            })
          : t("automations.detail.statusDraft", { date: shortDate(a.createdAt, i18n.language) });
  return (
    <p data-status-line className="flex flex-wrap items-center gap-x-1.5 text-md text-ink-muted">
      <AutomationStatusWord status={a.status} />
      <span>· {text}</span>
      {a.status !== "draft" && a.hasDraft && (
        <span className="num text-xs">
          · {t("automations.row.draftOf", { n: a.versions.at(-1)!.n })}
        </span>
      )}
    </p>
  );
}

export function Header({
  detail,
  onTurnOn,
  onPause,
  onDelete,
  onRunNow,
  onDuplicate,
}: {
  detail: Detail;
  onTurnOn: () => void;
  onPause: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();
  const names = useNames();
  const toast = useToast();
  const a = detail.automation;
  const manage = a.permissions.manage;
  const project = names.project(a.projectId);
  const live = a.versions.filter((v) => v.publishedAt !== null).at(-1);
  const manual = live?.flow.trigger.kind === "manual";
  const neverOn = a.versions.length === 1 && a.versions[0]!.publishedAt === null;
  const editLink = (label: string, primary = false, to: "edit" | "test" = "edit") => (
    <Link
      to={to === "edit" ? "/automations/$code/edit" : "/automations/$code/test"}
      params={{ code: a.code }}
      className={primary ? primaryButton : secondaryButton}
    >
      {label}
    </Link>
  );
  return (
    <header className="page-header flex shrink-0 flex-col gap-2 pb-6 [--page-header-pr:32px] [--page-header-pt:32px]">
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <span className={codeClass}>{a.code}</span>
        <span aria-hidden="true">·</span>
        {project ? (
          <Link to="/p/$code" params={{ code: project.code }} className={textLink}>
            {project.code} · {project.name}
          </Link>
        ) : (
          <span>{t("automations.general")}</span>
        )}
      </p>
      <div className="flex items-start gap-4">
        <h1 className="line-clamp-3 min-w-0 flex-1 text-2xl font-semibold text-ink [overflow-wrap:anywhere]">
          {a.name}
        </h1>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {manage && a.status === "draft" && (
            <>
              {editLink(t("automations.actions.edit"))}
              {editLink(t("automations.actions.test"), false, "test")}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.turnOn")}
              </button>
            </>
          )}
          {manage && a.status === "active" && !a.hasDraft && (
            <>
              <button type="button" className={secondaryButton} onClick={onPause}>
                {t("automations.actions.pause")}
              </button>
              {editLink(t("automations.actions.edit"), true)}
            </>
          )}
          {manage && a.status === "active" && a.hasDraft && (
            <>
              <button type="button" className={secondaryButton} onClick={onPause}>
                {t("automations.actions.pause")}
              </button>
              {editLink(t("automations.actions.openDraft"))}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.publishN", { n: a.versions.at(-1)!.n })}
              </button>
            </>
          )}
          {manage && a.status === "paused" && (
            <>
              {editLink(t("automations.actions.edit"))}
              <button type="button" className={primaryButton} onClick={onTurnOn}>
                {t("automations.actions.turnOn")}
              </button>
            </>
          )}
          <MenuButton
            menuLabel={t("automations.detail.more")}
            ariaLabel={t("automations.detail.more")}
            align="right"
            className={`${quietButton} w-8 justify-center px-0`}
            label={<MoreGlyph />}
          >
            {(close) => (
              <MenuGroup>
                {manage && manual && a.status === "active" && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      onRunNow();
                    }}
                  >
                    {t("automations.actions.runNow")}
                  </button>
                )}
                {manage && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      onDuplicate();
                    }}
                  >
                    {t("automations.actions.duplicate")}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    void navigator.clipboard?.writeText(`#/automations/${a.code}`).catch(() => {});
                    toast.show(t("automations.toast.linkCopied"));
                  }}
                >
                  {t("automations.actions.copyLink")}
                </button>
                {manage && neverOn && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      onDelete();
                    }}
                  >
                    {t("automations.actions.deleteDraft")}
                  </button>
                )}
              </MenuGroup>
            )}
          </MenuButton>
        </div>
      </div>
      {a.description && <Description text={a.description} />}
      <StatusLine a={a} />
    </header>
  );
}

function Description({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className="flex max-w-[72ch] flex-col items-start gap-0.5">
      <p className={`text-md text-ink-muted ${open || !long ? "" : "line-clamp-3"}`}>{text}</p>
      {long && (
        <button
          type="button"
          className="text-sm text-ink underline-offset-4 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("automations.detail.less") : t("automations.detail.more")}
        </button>
      )}
    </div>
  );
}
