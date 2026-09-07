import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DocsChat } from "../../components/docs-chat";
import type { DocDecisionRef, DocProjectReleaseRef, DocSpace } from "../../lib/docs-api";
import { formatDate, formatRelativeTime } from "../../lib/format";
import {
  docBriefQueryOptions,
  docProjectHighlightsQueryOptions,
  projectDocSpacesQueryOptions,
  projectQueryOptions,
} from "../../lib/queries";

/**
 * Una riga di decisione nella home: titolo, decisione e da chi.
 *
 * Una decisione SUPERATA resta in elenco, attenuata e marcata: nasconderla
 * darebbe l'impressione che non sia mai stata presa, che è l'opposto di ciò che
 * un registro serve a ricordare.
 */
function ProjectDecisionRow({ decision }: { decision: DocDecisionRef }) {
  const { t } = useTranslation();
  return (
    <li className={`border-b border-line py-2.5 ${decision.superseded ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px]">{decision.title}</span>
        <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
          {t(`docs:decisions.source.${decision.source}`)}
        </span>
        {decision.superseded && (
          <span className="font-mono text-[10px] tracking-[0.12em] text-signal-dim uppercase">
            {t("docs:decisions.superseded")}
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] text-fg-muted">{decision.decision}</p>
      <p className="mt-1 font-mono text-[11px] text-fg-faint">
        {formatDate(decision.decidedAt)} ·{" "}
        {decision.decidedByEmail
          ? t("docs:decisions.by", { email: decision.decidedByEmail })
          : t("docs:decisions.byNobody")}
      </p>
    </li>
  );
}

/**
 * Home della documentazione di PROGETTO (`/docs/project/$projectId`, Fase 2).
 * Segmento `project/` distinto dal `/docs/$projectId` per-repo (dove il param è
 * un repositoryId): qui il param è un vero projectId.
 *
 * È la porta d'ingresso per chi NON conosce il prodotto, quindi risponde in
 * quest'ordine: di cosa si tratta (sintesi dal brief del repo principale), da
 * dove si comincia, quali repository ci sono, cosa è cambiato di recente. La
 * chat cross-repo resta disponibile ma come pannello richiamabile — non occupa
 * metà schermo prima ancora che l'utente sappia cosa chiedere.
 */

/** Repo "principale" del progetto: quello con più pagine documentate. */
function mainSpace(spaces: DocSpace[]): DocSpace | undefined {
  return [...spaces].sort((a, b) => b.pageCount - a.pageCount)[0];
}

/** Le domande di esempio della chat, dal catalogo i18n. */
const SUGGESTED_QUESTION_KEYS = [
  "docs:project.suggested1",
  "docs:project.suggested2",
  "docs:project.suggested3",
];

/** Voce del changelog cross-repo: repo d'origine, titolo, data. */
function ProjectReleaseRow({ release }: { release: DocProjectReleaseRef }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2 last:border-b-0">
      <Link
        to="/docs/$projectId/releases"
        params={{ projectId: release.repositoryId }}
        className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-signal"
      >
        {release.repositoryName}
      </Link>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{release.title}</span>
      {release.significant === false && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
          {t("docs:releases.minorBadge")}
        </span>
      )}
      <time
        dateTime={release.createdAt}
        title={formatRelativeTime(release.createdAt)}
        className="shrink-0 font-mono text-[11px] text-fg-faint"
      >
        {formatDate(release.createdAt)}
      </time>
    </li>
  );
}

export function ProjectDocsLanding() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/project/$projectId" });
  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const { data: spaces } = useSuspenseQuery(projectDocSpacesQueryOptions(projectId));
  const { data: highlights } = useQuery(docProjectHighlightsQueryOptions(projectId));

  // Il brief del repo principale fa da sintesi del progetto: è il documento che
  // risponde a "di cosa si tratta". Best-effort: un 404 lascia la copy neutra.
  const main = mainSpace(spaces);
  const { data: briefResponse } = useQuery({
    ...docBriefQueryOptions(main?.repositoryId ?? ""),
    enabled: Boolean(main),
    retry: false,
  });

  // Chat NON aperta di default: prima si orienta, poi si chiede.
  const [chatOpen, setChatOpen] = useState(false);

  const latestRelease = highlights?.latestReleases[0];
  const suggestedQuestions = SUGGESTED_QUESTION_KEYS.map((key) => t(key));

  return (
    <div className="relative flex h-full min-h-0 flex-col lg:flex-row">
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8">
          <header className="border-b border-line pb-6">
            <p className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
              {t("docs:project.eyebrow")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-fg-muted">
              {briefResponse?.brief.identity ?? t("docs:project.subtitle")}
            </p>
            {/*
              La Roadmap (Fase 5) è l'altra metà di questa pagina per chi non
              legge codice: qui c'è "di cosa si tratta", di là "dove siamo".
              Sta fuori dal blocco "Da dove cominciare" perché quello dipende da
              un repository documentato, e la roadmap esiste comunque.
            */}
            <Link
              to="/projects/$projectId/roadmap"
              params={{ projectId }}
              className="mt-4 inline-block font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase transition-colors hover:text-signal"
            >
              {t("projects:roadmap.link")} →
            </Link>
          </header>

          {/* Punti d'ingresso: il percorso consigliato a chi arriva a freddo. */}
          {main && (
            <section className="mt-10" aria-label={t("docs:overview.startHere")}>
              <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
                {t("docs:overview.startHere")}
              </h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {briefResponse && (
                  <Link
                    to="/docs/$projectId/brief"
                    params={{ projectId: main.repositoryId }}
                    className="group flex items-baseline justify-between gap-3 rounded-sm border border-line px-3 py-2 transition-colors hover:border-ink-700 hover:bg-ink-900"
                  >
                    <span className="text-[13px] text-fg-muted group-hover:text-fg">
                      {t("docs:brief.link")}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                      {main.name}
                    </span>
                  </Link>
                )}
                <Link
                  to="/docs/$projectId"
                  params={{ projectId: main.repositoryId }}
                  className="group flex items-baseline justify-between gap-3 rounded-sm border border-line px-3 py-2 transition-colors hover:border-ink-700 hover:bg-ink-900"
                >
                  <span className="text-[13px] text-fg-muted group-hover:text-fg">
                    {t("docs:project.mainSpace")}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-fg-faint">{main.name}</span>
                </Link>
                {latestRelease && (
                  <Link
                    to="/docs/$projectId/releases"
                    params={{ projectId: latestRelease.repositoryId }}
                    className="group flex items-baseline justify-between gap-3 rounded-sm border border-line px-3 py-2 transition-colors hover:border-ink-700 hover:bg-ink-900"
                  >
                    <span className="min-w-0 truncate text-[13px] text-fg-muted group-hover:text-fg">
                      {latestRelease.title}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                      {formatDate(latestRelease.createdAt)}
                    </span>
                  </Link>
                )}
              </div>
            </section>
          )}

          {/* Repository del progetto: dove vive cosa. */}
          <section className="mt-10" aria-label={t("docs:project.spacesHeading")}>
            <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
              {t("docs:project.spacesHeading")}
            </h2>
            {spaces.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">{t("docs:project.spacesEmpty")}</p>
            ) : (
              <ul className="mt-3 rounded-sm border border-line bg-ink-900">
                {spaces.map((space) => {
                  const release = highlights?.latestReleases.find(
                    (item) => item.repositoryId === space.repositoryId,
                  );
                  return (
                    <li key={space.repositoryId} className="border-b border-line last:border-b-0">
                      <Link
                        to="/docs/$projectId"
                        params={{ projectId: space.repositoryId }}
                        className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-5 py-4 transition-colors hover:bg-ink-850"
                      >
                        <span className="text-[15px] font-medium text-fg">{space.name}</span>
                        <span className="font-mono text-[12px] text-fg-faint">{space.slug}</span>
                        <span className="font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase">
                          {t("docs:hub.pageCount", { count: space.pageCount })}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] whitespace-nowrap text-fg-faint">
                          {release ? (
                            <>
                              {release.title} · {formatDate(release.createdAt)}
                            </>
                          ) : space.lastGenerationAt ? (
                            t("docs:hub.lastGenerated", {
                              date: formatRelativeTime(space.lastGenerationAt),
                            })
                          ) : space.pageCount > 0 ? (
                            t("docs:hub.neverGenerated")
                          ) : (
                            t("docs:hub.notGenerated")
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/*
            DECISIONI (Fase 5): i fatti decisi da persone su questo progetto.
            Sta accanto a "Novità" perché risponde all'altra metà di "cosa è
            successo": le release dicono cosa è cambiato, le decisioni perché.
            `latestDecisions` è opzionale (server sceso di immagine): l'assenza
            e la lista vuota sono la stessa cosa, e la sezione non compare.
          */}
          {highlights && (highlights.latestDecisions?.length ?? 0) > 0 && (
            <section className="mt-10" aria-label={t("docs:decisions.homeTitle")}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
                  {t("docs:decisions.homeTitle")}
                </h2>
                <Link
                  to="/docs/project/$projectId/decisions"
                  params={{ projectId }}
                  className="font-mono text-[11px] text-signal hover:underline"
                >
                  {t("docs:decisions.homeAll")}
                </Link>
              </div>
              <ul className="mt-3">
                {highlights.latestDecisions!.map((decision) => (
                  <ProjectDecisionRow key={decision.id} decision={decision} />
                ))}
              </ul>
            </section>
          )}

          {/* Novità: il changelog unificato dei repository del progetto. */}
          {highlights && highlights.latestReleases.length > 0 && (
            <section className="mt-10" aria-label={t("docs:overview.whatsNew")}>
              <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
                {t("docs:overview.whatsNew")}
              </h2>
              <ul className="mt-3">
                {highlights.latestReleases.slice(0, 6).map((release) => (
                  <ProjectReleaseRow
                    key={`${release.repositoryId}:${release.slug}`}
                    release={release}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </section>

      {/* Chat cross-repo di progetto: stesso componente della chat per-repo,
          parametrizzato su scope="project" (endpoint di progetto + citazioni
          col repository). Chiusa finché non la si richiama. */}
      <DocsChat
        projectId={projectId}
        scope="project"
        open={chatOpen}
        onOpenChange={setChatOpen}
        suggestedQuestions={suggestedQuestions}
      />
    </div>
  );
}
