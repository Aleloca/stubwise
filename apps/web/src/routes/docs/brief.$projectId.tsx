import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api";
import type { DocBriefResponse, ProductExclusion, ProjectBrief } from "../../lib/docs-api";
import { docBriefQueryOptions } from "../../lib/queries";

/**
 * TAB "BRIEF" dello spazio Docs (`/docs/$projectId/brief`): pannello di SOLA
 * LETTURA che rende il project brief della generazione corrente — identità,
 * attori, superfici, glossario, invarianti, journey e (in fondo, separati e con
 * nota) i fatti riservati rilevati. Superficie interna autenticata: i
 * confidentialFacts sono qui per l'AUDIT, non entrano mai nella documentazione
 * pubblica.
 *
 * Il brief è opzionale: se nessuna generazione del repo ne ha uno il server
 * risponde 404 → stato "nessun brief (rigenera la documentazione)".
 */
export function DocsBriefView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/$projectId/brief" });
  const { data, error, isLoading } = useQuery(docBriefQueryOptions(projectId));

  if (isLoading) return null;

  // 404 = nessun brief: esito atteso, messaggio dedicato (niente pannello d'errore).
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title={t("docs:brief.empty")} hint={t("docs:brief.emptyHint")} />;
  }
  if (error) {
    return <EmptyState title={t("docs:brief.error")} hint="" />;
  }
  if (!data) return null;

  const brief = data.brief;

  return (
    <article className="mx-auto max-w-3xl p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("docs:brief.title")}</h1>
        <p className="mt-2 text-sm text-fg-muted">{t("docs:brief.subtitle")}</p>
        <GenerationMeta generation={data.generation} />
      </header>

      <div className="mt-8 flex flex-col gap-10">
        {brief.identity.trim() !== "" && (
          <Section title={t("docs:brief.sectionIdentity")}>
            <p className="text-sm leading-relaxed text-fg">{brief.identity}</p>
          </Section>
        )}

        <ActorsSection brief={brief} />
        <SurfacesSection brief={brief} />
        <GlossarySection brief={brief} />
        <InvariantsSection brief={brief} />
        <JourneysSection brief={brief} />
        <SourcesSection brief={brief} />
        <ConfidentialSection brief={brief} />
        <ExclusionsSection exclusions={data.productExclusions} />
      </div>
    </article>
  );
}

/**
 * Riga di metadati sotto il titolo: data della generazione da cui provengono brief ed
 * esclusioni + (se noto) il commit documentato. Ancora il tutto a una precisa generazione,
 * così l'utente sa a quale snapshot il brief si riferisce (coerenza A3).
 */
function GenerationMeta({ generation }: { generation: DocBriefResponse["generation"] }) {
  const { t } = useTranslation();
  const date = new Date(generation.createdAt);
  const dateLabel = Number.isNaN(date.getTime()) ? generation.createdAt : date.toLocaleString();
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint">
      <span>{t("docs:brief.generatedAt", { date: dateLabel })}</span>
      {generation.commitSha !== null && generation.commitSha !== "" && (
        <span>
          {t("docs:brief.commit")}{" "}
          <code className="text-fg-muted">{generation.commitSha.slice(0, 10)}</code>
        </span>
      )}
    </p>
  );
}

/**
 * Pagine ESCLUSE dalla documentazione pubblica dal verificatore segreti (Fase C, fail-closed):
 * per ciascuna il titolo e il motivo (il fatto/passaggio incriminato). Visibile SOLO se ce
 * n'è almeno una — così una generazione pulita non mostra la sezione.
 */
function ExclusionsSection({ exclusions }: { exclusions: ProductExclusion[] }) {
  const { t } = useTranslation();
  if (exclusions.length === 0) return null;
  return (
    <section
      className="rounded-sm border border-signal/30 bg-signal/5 p-4"
      aria-label={t("docs:brief.sectionExclusions")}
    >
      <h2 className="font-mono text-[11px] tracking-[0.14em] text-signal uppercase">
        {t("docs:brief.sectionExclusions")}
      </h2>
      <p className="mt-1 text-[12px] text-fg-muted">{t("docs:brief.exclusionsNote")}</p>
      <ul className="mt-4 flex flex-col gap-3">
        {exclusions.map((exclusion, i) => (
          <li key={i} className="border-t border-signal/20 pt-3 first:border-t-0 first:pt-0">
            <p className="text-sm font-medium text-fg">{exclusion.title}</p>
            {exclusion.fact.trim() !== "" && (
              <p className="mt-0.5 text-[12px] text-fg-muted">
                {t("docs:brief.exclusionReason")}: {exclusion.fact}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Stato vuoto/errore centrato, coerente col resto dello spazio Docs. */
function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="text-center">
        <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">{title}</p>
        {hint !== "" && <p className="mt-2 text-sm text-fg-muted">{hint}</p>}
      </div>
    </div>
  );
}

/** Sezione con intestazione mono in stile terminal. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Badge interno/esterno per attori e superfici. */
function ScopeBadge({ internal }: { internal: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.06em] uppercase ${
        internal
          ? "border-signal/40 text-signal"
          : "border-line-strong text-fg-muted"
      }`}
    >
      {internal ? t("docs:brief.internalBadge") : t("docs:brief.externalBadge")}
    </span>
  );
}

function ActorsSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.actors.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionActors")}>
      <ul className="flex flex-col gap-2">
        {brief.actors.map((actor, i) => (
          <li key={`${actor.name}:${i}`} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="font-medium text-fg">{actor.name}</span>
            <ScopeBadge internal={actor.internal} />
            {actor.description !== "" && (
              <span className="text-fg-muted">— {actor.description}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SurfacesSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.surfaces.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionSurfaces")}>
      <ul className="flex flex-col gap-3">
        {brief.surfaces.map((surface, i) => (
          <li key={`${surface.name}:${i}`} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-fg">{surface.name}</span>
              <ScopeBadge internal={surface.internal} />
              {surface.type !== "" && (
                <span className="font-mono text-[11px] text-fg-muted">{surface.type}</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
              <code className="rounded-sm bg-ink-900 px-1.5 py-0.5 font-mono text-fg-muted">
                {surface.rootPath}
              </code>
              {surface.audience !== "" && (
                <span>{t("docs:brief.surfaceAudience", { audience: surface.audience })}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function GlossarySection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.glossary.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionGlossary")}>
      <dl className="flex flex-col gap-2">
        {brief.glossary.map((entry, i) => (
          <div key={`${entry.term}:${i}`} className="text-sm">
            <dt className="inline font-medium text-fg">{entry.term}</dt>
            <dd className="inline text-fg-muted"> — {entry.definition}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function InvariantsSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.invariants.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionInvariants")}>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg">
        {brief.invariants.map((inv, i) => (
          <li key={i}>{inv}</li>
        ))}
      </ul>
    </Section>
  );
}

function JourneysSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.journeys.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionJourneys")}>
      <ul className="flex flex-col gap-2">
        {brief.journeys.map((journey, i) => (
          <li key={`${journey.title}:${i}`} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-fg">{journey.title}</span>
              {journey.actor !== "" && (
                <span className="font-mono text-[11px] text-fg-muted">
                  {t("docs:brief.journeyBy", { actor: journey.actor })}
                </span>
              )}
            </div>
            {journey.summary !== "" && (
              <p className="mt-0.5 text-fg-muted">{journey.summary}</p>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SourcesSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.existingSources.length === 0) return null;
  return (
    <Section title={t("docs:brief.sectionSources")}>
      <ul className="flex flex-col gap-1">
        {brief.existingSources.map((src, i) => (
          <li key={`${src}:${i}`}>
            <code className="font-mono text-[12px] text-fg-muted">{src}</code>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Fatti riservati rilevati: sezione a parte, evidenziata, con nota che NON
 * finiscono nella documentazione pubblica. Per ogni fatto: cos'è, perché è
 * riservato, dove nel codice, come NON deve apparire.
 */
function ConfidentialSection({ brief }: { brief: ProjectBrief }) {
  const { t } = useTranslation();
  if (brief.confidentialFacts.length === 0) return null;
  return (
    <section
      className="rounded-sm border border-danger/30 bg-danger/5 p-4"
      aria-label={t("docs:brief.sectionConfidential")}
    >
      <h2 className="font-mono text-[11px] tracking-[0.14em] text-danger uppercase">
        {t("docs:brief.sectionConfidential")}
      </h2>
      <p className="mt-1 text-[12px] text-fg-muted">{t("docs:brief.confidentialNote")}</p>
      <ul className="mt-4 flex flex-col gap-4">
        {brief.confidentialFacts.map((fact, i) => (
          <li key={i} className="border-t border-danger/20 pt-3 first:border-t-0 first:pt-0">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <FactRow label={t("docs:brief.confidentialFact")} value={fact.fact} />
              {fact.reason !== "" && (
                <FactRow label={t("docs:brief.confidentialReason")} value={fact.reason} />
              )}
              {fact.source !== "" && (
                <FactRow label={t("docs:brief.confidentialSource")} value={fact.source} mono />
              )}
              {fact.avoid !== "" && (
                <FactRow label={t("docs:brief.confidentialAvoid")} value={fact.avoid} />
              )}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FactRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="font-mono text-[10px] tracking-[0.06em] text-fg-faint uppercase">{label}</dt>
      <dd className={mono ? "font-mono text-[12px] text-fg-muted" : "text-fg"}>{value}</dd>
    </>
  );
}
