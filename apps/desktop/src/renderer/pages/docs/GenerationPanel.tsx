import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useResumeGeneration, useStartGeneration } from "../../data/queries";
import type { DocSpaceView, Project } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { useToast } from "../../tasks-ui/Toast";
import { clock, DisclosureGlyph } from "../claude/conversation/parts";
import { PlusIcon, smallPrimary, smallSecondary } from "../task/parts";
import { GenerationSign, generationWords } from "./parts";

// Il pannello di generazione in fondo all'albero (shape docs.md §6, A 10):
// chiuso è una riga — segno, stato breve, data —; aperto (clic) mostra
// ultima generazione, commit, costo, provider, avanzamento e motivo, e le
// azioni: «Generate documentation» / «Resume now» / «Retry» con
// `docs.generate`, «+ New manual page» con `docs.edit`. I flag li dà il
// livello dati; gli stati avanzano da soli (la lettura si ripete).

/** Il costo di una generazione, in dollari, nella lingua di chi guarda. */
export const usd = (value: number, language: string) =>
  new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(value);

export function GenerationPanel({ project, space }: { project: Project; space: DocSpaceView }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const g = space.generation;
  const words = generationWords(space, t, i18n.language);
  const date = g.status !== "never" && g.lastAt ? formatDate(g.lastAt, i18n.language) : null;
  // Riuscita: la data è già nelle parole («Generated Oct 21 at a1b2c3d»).
  const trailing = g.status === "succeeded" ? null : date;

  return (
    <div className="shrink-0 border-t border-rule">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={t("docs.generation.spoken", { status: words })}
        title={words}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out outline-none hover:bg-ink/4 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <GenerationSign status={g.status} />
        <span aria-live="polite" className="num min-w-0 flex-1 truncate">
          {words}
        </span>
        {trailing && <span className="num shrink-0 text-xs text-ink-faint">{trailing}</span>}
        <span className="shrink-0 text-ink-faint">
          <DisclosureGlyph open={open} />
        </span>
      </button>
      {open && (
        <section
          id={regionId}
          aria-label={t("docs.panel.title")}
          className="event-enter flex flex-col gap-3 px-3 pb-3"
        >
          <Details space={space} />
          <Actions project={project} space={space} />
        </section>
      )}
    </div>
  );
}

function Details({ space }: { space: DocSpaceView }) {
  const { t, i18n } = useTranslation();
  const g = space.generation;
  const rows: [string, ReactNode][] = [
    [
      t("docs.panel.lastGenerated"),
      g.lastAt ? (
        <span className="num">{formatDate(g.lastAt, i18n.language)}</span>
      ) : (
        t("docs.panel.none")
      ),
    ],
  ];
  if (g.commit) {
    rows.push([
      t("docs.panel.commit"),
      <span key="c" className="num font-semibold">
        {g.commit.slice(0, 7)}
      </span>,
    ]);
  }
  if (g.costUsd !== null) {
    rows.push([t("docs.panel.cost"), <span className="num">{usd(g.costUsd, i18n.language)}</span>]);
  }
  if (g.provider) rows.push([t("docs.panel.provider"), g.provider]);
  if (g.progress && (g.status === "running" || g.status === "paused" || g.status === "held")) {
    rows.push([
      t("docs.panel.progress"),
      <span className="num">{t("docs.panel.progressValue", g.progress)}</span>,
    ]);
  }
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-xs leading-5 text-ink-muted">{label}</dt>
            <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {g.reason && (g.status === "failed" || g.status === "held" || g.status === "paused") && (
        <p className="text-sm text-ink">
          {t(`docs.generation.reasons.${g.reason}`)}
          {g.status === "paused" && g.resumesAt && (
            <span className="text-ink-muted">
              {" "}
              {t("docs.panel.resumesAround", { time: clock(g.resumesAt, i18n.language) })}
            </span>
          )}
        </p>
      )}
    </>
  );
}

function Actions({ project, space }: { project: Project; space: DocSpaceView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const start = useStartGeneration();
  const resume = useResumeGeneration();
  const status = space.generation.status;
  const busy = start.isPending || resume.isPending;
  const onError = { onError: () => toast.error(t("docs.panel.startFailed")) };

  let primary: ReactNode = null;
  if (space.permissions.generate) {
    // «Resume now» solo da una pausa sul limite (shape §5): una generazione
    // trattenuta dal budget aspetta che il budget cambi, e lo dice il motivo.
    if (status === "paused") {
      primary = (
        <button
          type="button"
          disabled={busy}
          className={smallPrimary}
          onClick={() => resume.mutate(space.repositoryId, onError)}
        >
          {t("docs.panel.resume")}
        </button>
      );
    } else if (status === "failed" || status === "never" || status === "succeeded") {
      primary = (
        <button
          type="button"
          disabled={busy}
          className={status === "succeeded" ? smallSecondary : smallPrimary}
          onClick={() => start.mutate(space.repositoryId, onError)}
        >
          {status === "failed" ? t("docs.panel.retry") : t("docs.index.generate")}
        </button>
      );
    }
  }
  if (!primary && !space.permissions.edit) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      {space.permissions.edit && (
        <Link
          to="/p/$code/docs/$repo/new"
          params={{ code: project.code, repo: space.name }}
          className={`${smallSecondary} gap-1`}
        >
          <PlusIcon />
          {t("docs.index.newPage")}
        </Link>
      )}
    </div>
  );
}
