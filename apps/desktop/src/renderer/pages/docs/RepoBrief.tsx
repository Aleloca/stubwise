import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRepoBrief } from "../../data/queries";
import type { RepoBrief as Brief } from "../../data/types";
import { PageError } from "../../tasks-ui/PageStates";
import { DocsGroup, ReadingSkeleton, useSpace } from "./parts";

// Il brief del repository (shape docs.md §5): le sezioni del web come gruppi
// con l'intestazione maiuscoletta, testo a 72ch; i fatti riservati come
// righe (fatto · perché · dove nel codice · come non deve comparire), con la
// nota che sono mostrati per verifica; le pagine escluse col motivo.

export function RepoBrief() {
  const { t } = useTranslation();
  const { space } = useSpace();
  const brief = useRepoBrief(space.repositoryId);
  return (
    <article className="event-enter flex flex-col">
      <header className="flex flex-col gap-1.5 pt-8">
        <h1 className="text-2xl font-semibold text-ink">{t("docs.brief.title")}</h1>
        <p className="text-sm text-ink-muted">{space.name}</p>
      </header>
      {brief.isError ? (
        <div className="pt-6">
          <PageError message={t("docs.brief.error")} onRetry={() => void brief.refetch()} />
        </div>
      ) : brief.isPending ? (
        <ReadingSkeleton />
      ) : brief.data ? (
        <BriefBody brief={brief.data} />
      ) : (
        <p className="pt-8 text-md text-ink-muted">{t("docs.brief.empty")}</p>
      )}
    </article>
  );
}

const text = "max-w-[72ch] text-md text-ink";

function BriefBody({ brief }: { brief: Brief }) {
  const { t } = useTranslation();
  return (
    <>
      <DocsGroup title={t("docs.brief.identity")}>
        <div className="border-t border-rule px-2 pt-3">
          <p className={text}>{brief.identity}</p>
        </div>
      </DocsGroup>

      <DocsGroup title={t("docs.brief.actors")} count={brief.actors.length}>
        <Terms items={brief.actors.map((a) => [a.name, a.description])} />
      </DocsGroup>

      <DocsGroup title={t("docs.brief.surfaces")} count={brief.surfaces.length}>
        <Terms
          items={brief.surfaces.map((s) => [
            s.name,
            t("docs.brief.usedBy", { audience: s.audience }),
          ])}
        />
      </DocsGroup>

      <DocsGroup title={t("docs.brief.glossary")} count={brief.glossary.length}>
        <Terms items={brief.glossary.map((g) => [g.term, g.definition])} />
      </DocsGroup>

      <DocsGroup title={t("docs.brief.invariants")} count={brief.invariants.length}>
        <ul className="border-t border-rule">
          {brief.invariants.map((rule) => (
            <li key={rule} className="border-b border-rule px-2 py-2.5">
              <p className={text}>{rule}</p>
            </li>
          ))}
        </ul>
      </DocsGroup>

      <DocsGroup title={t("docs.brief.journeys")} count={brief.journeys.length}>
        <ul className="border-t border-rule">
          {brief.journeys.map((j) => (
            <li key={j.name} className="flex flex-col gap-1.5 border-b border-rule px-2 py-2.5">
              <span className="text-md font-semibold text-ink">{j.name}</span>
              <ol className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-ink-muted">
                {j.steps.map((step, i) => (
                  <li key={step} className="flex items-baseline gap-1.5">
                    <span className="num text-xs text-ink-faint">{i + 1}</span>
                    <span className="text-ink">{step}</span>
                    {i < j.steps.length - 1 && <span aria-hidden="true">→</span>}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      </DocsGroup>

      <DocsGroup title={t("docs.brief.sources")} count={brief.sources.length}>
        <Terms items={brief.sources.map((s) => [s.label, <Path key={s.path} path={s.path} />])} />
      </DocsGroup>

      <DocsGroup title={t("docs.brief.confidential")} count={brief.confidentialFacts.length}>
        <p className="max-w-[72ch] pb-2 text-sm text-ink-muted">
          {t("docs.brief.confidentialNote")}
        </p>
        {brief.confidentialFacts.length === 0 ? (
          <p className="border-t border-rule px-2 py-3 text-md text-ink-muted">
            {t("docs.brief.none")}
          </p>
        ) : (
          <ul className="border-t border-rule">
            {brief.confidentialFacts.map((f) => (
              <li key={f.fact} className="flex flex-col gap-1.5 border-b border-rule px-2 py-3">
                <span className="text-md font-semibold text-ink">{f.fact}</span>
                <dl className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-muted">{t("docs.brief.why")}</dt>
                  <dd className="text-ink">{f.reason}</dd>
                  <dt className="text-ink-muted">{t("docs.brief.where")}</dt>
                  <dd className="min-w-0">
                    <Path path={f.where} />
                  </dd>
                  <dt className="text-ink-muted">{t("docs.brief.mustNot")}</dt>
                  <dd className="text-ink">{f.mustNotAppearAs}</dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </DocsGroup>

      <DocsGroup title={t("docs.brief.excluded")} count={brief.excludedPages.length}>
        {brief.excludedPages.length === 0 ? (
          <p className="border-t border-rule px-2 py-3 text-md text-ink-muted">
            {t("docs.brief.none")}
          </p>
        ) : (
          <Terms items={brief.excludedPages.map((p) => [p.title, p.reason])} />
        )}
      </DocsGroup>
    </>
  );
}

/** Un elenco di termini: nome (600) e spiegazione, una riga per voce. */
function Terms({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="border-t border-rule">
      {items.map(([term, detail]) => (
        <div
          key={term}
          className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-4 border-b border-rule px-2 py-2.5"
        >
          <dt className="text-md font-semibold text-ink">{term}</dt>
          <dd className="max-w-[60ch] text-md text-ink">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Un percorso del codice: a spaziatura fissa (è codice, A 12), spezzato sugli «/». */
function Path({ path }: { path: string }) {
  return (
    <code className="font-code rounded-[4px] bg-ink/8 px-1 py-px text-[0.92em] break-all text-ink">
      {path}
    </code>
  );
}
