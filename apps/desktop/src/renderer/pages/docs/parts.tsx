import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { createContext, useContext, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  DocGeneration,
  DocPageRef,
  DocRelease,
  DocSpaceView,
  DocTreeCategory,
  DocTreeNode,
  Project,
} from "../../data/types";
import { formatDate } from "../../notifications/time";
import { WorkingRing } from "../claude/conversation/parts";

// I pezzi comuni dei Docs (shape docs.md): lo stato della generazione in
// parole col suo segno, la riga di una pagina (codice + titolo + percorso),
// i gruppi con l'intestazione maiuscoletta, la pagina non trovata.

/** Lo spazio aperto: la shell lo dà alle viste figlie (indice, pagina, form). */
export interface SpaceContextValue {
  project: Project;
  space: DocSpaceView;
  /** Apre una categoria nell'albero e ci porta il fuoco (l'indice: «Show in the tree»). */
  revealCategory: (kind: DocPageRef["kind"]) => void;
}

export const SpaceContext = createContext<SpaceContextValue | null>(null);

export function useSpace(): SpaceContextValue {
  const value = useContext(SpaceContext);
  if (!value) throw new Error("useSpace fuori da uno spazio dei Docs");
  return value;
}

/** Il link a una pagina: `#/p/<CODE>/docs/<repository>/<slug>`. */
export const pageLink = (code: string, repo: string, slug: string) =>
  ({ to: "/p/$code/docs/$repo/$slug", params: { code, repo, slug } }) as const;

export const spaceLink = (code: string, repo: string) =>
  ({ to: "/p/$code/docs/$repo", params: { code, repo } }) as const;

/** Il link da copiare (hash dell'app), lo stesso delle citazioni. */
export const pageHref = (code: string, repo: string, slug: string) =>
  `#/p/${code}/docs/${repo}/${slug}`;

/** Lo stato della generazione di uno spazio, in parole (sempre presenti accanto al segno). */
export function generationWords(space: DocSpaceView, t: TFunction, language: string): string {
  const g = space.generation;
  switch (g.status) {
    case "succeeded":
      return g.lastAt && g.commit
        ? t("docs.generation.succeeded", {
            date: formatDate(g.lastAt, language),
            commit: g.commit.slice(0, 7),
          })
        : t("docs.generation.succeededPlain");
    case "never":
      return space.manualOnly ? t("docs.generation.manualOnly") : t("docs.generation.never");
    case "paused":
      return t("docs.generation.paused");
    case "running":
      return g.progress
        ? t("docs.generation.runningProgress", g.progress)
        : t("docs.generation.running");
    case "held":
      return g.reason
        ? t("docs.generation.heldReason", { reason: t(`docs.generation.short.${g.reason}`) })
        : t("docs.generation.held");
    default:
      return t(`docs.generation.${g.status}`);
  }
}

/**
 * Il segno dello stato (§6): in coda o in corso l'anello di Claude al lavoro
 * (inchiostro: è Claude che scrive); riuscita nessun segno; fallita
 * `critical`; trattenuta o in pausa `warning`; mai generata `ink-faint`.
 */
export function GenerationSign({ status }: { status: DocGeneration["status"] }) {
  if (status === "queued" || status === "running") return <WorkingRing size={10} />;
  if (status === "succeeded") return null;
  const tone =
    status === "failed" ? "text-critical" : status === "never" ? "text-ink-faint" : "text-warning";
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${tone}`}
    >
      {status === "failed" && <path d="m3 3 6 6m0-6-6 6" />}
      {(status === "paused" || status === "held") && <path d="M4.5 3v6M7.5 3v6" />}
      {status === "never" && <circle cx="6" cy="6" r="4" strokeDasharray="1.5 2" />}
    </svg>
  );
}

/**
 * Stato + parole, su una riga: ellissi e testo intero al passaggio. `live`
 * annuncia i cambi (in coda → in corso → riuscita) con calma (§7).
 */
export function GenerationLine({
  space,
  className = "",
  live = false,
}: {
  space: DocSpaceView;
  className?: string;
  live?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const words = generationWords(space, t, i18n.language);
  return (
    <span
      title={words}
      aria-live={live ? "polite" : undefined}
      className={`flex min-w-0 items-center gap-1.5 ${className}`}
    >
      <GenerationSign status={space.generation.status} />
      <span className="num min-w-0 truncate">{words}</span>
    </span>
  );
}

/**
 * Un gruppo di una pagina dei Docs: intestazione maiuscoletta (h2) col
 * conteggio e un'azione, poi l'elenco. Filetto sopra, niente riquadri.
 */
export function DocsGroup({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col pt-7">
      <div className="flex min-h-7 items-center gap-2 pb-2">
        <h2 id={id} className="heading-group">
          {title}
        </h2>
        {count !== undefined && count > 0 && (
          <span className="num text-xs text-ink-faint">{count}</span>
        )}
        {action && <span className="ml-auto flex items-center gap-1">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** Una riga d'elenco come link: tutta la riga è cliccabile, tinta al passaggio. */
export const rowLinkClass =
  "flex min-h-11 min-w-0 items-center gap-3 border-b border-rule px-2 py-2 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/** Il codice di catalogo: cifre tabellari, 600, accanto al nome. */
export function DocCode({ code }: { code: string }) {
  return (
    <span className="num w-[60px] shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
      {code}
    </span>
  );
}

/** Una pagina in un elenco: codice · titolo · percorso (12 px, tenue); `trailing` a destra. */
export function PageRefRow({
  page,
  projectCode,
  repo,
  trailing,
}: {
  page: DocPageRef;
  projectCode: string;
  repo: string;
  trailing?: ReactNode;
}) {
  return (
    <li>
      <Link {...pageLink(projectCode, repo, page.slug)} className={rowLinkClass}>
        <DocCode code={page.code} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md text-ink" title={page.title}>
            {page.title}
          </span>
          {page.path && (
            <span className="truncate text-xs text-ink-faint" title={page.path}>
              {page.path}
            </span>
          )}
        </span>
        {trailing}
      </Link>
    </li>
  );
}

/** «Start here»: le pagine di prodotto di uno spazio (al più `n`), in profondità. */
export function productPages(categories: readonly DocTreeCategory[], n = 2): DocPageRef[] {
  const leaves = (nodes: DocTreeNode[]): DocPageRef[] =>
    nodes.flatMap((node) => (node.page ? [node.page] : leaves(node.children)));
  return leaves(categories.find((c) => c.kind === "product")?.nodes ?? []).slice(0, n);
}

/** La prima riga di una release (senza segni del Markdown), per gli elenchi. */
export const releaseFirstLine = (release: DocRelease) =>
  (release.text.split("\n").find((l) => l.trim()) ?? "")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-\d.]+\s+/, "")
    .trim();

/** «Minor» in parola, col filetto: mai il solo colore. */
export function MinorMark() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-sm border border-rule-strong px-1.5 text-xs text-ink-muted">
      {t("docs.minor")}
    </span>
  );
}

/**
 * Pagina (o repository) che non c'è, o che chi guarda non legge: la stessa
 * frase per i due casi (R-G5), e il ritorno all'indice.
 */
export function DocNotFound({ back }: { back: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col items-start gap-2 pt-8">
      <h1 className="text-2xl font-semibold text-ink">{t("docs.page.notFound")}</h1>
      <p className="text-md text-ink-muted">{t("docs.page.notFoundBody")}</p>
      {back}
    </section>
  );
}

export const backLinkClass = "text-md text-ink underline underline-offset-4 hover:decoration-ink";

/** Chi vede il progetto ma non i suoi Docs: niente titoli, niente conteggi. */
export function DocsForbidden() {
  const { t } = useTranslation();
  return (
    <section className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{t("docs.forbidden")}</h1>
      <p className="max-w-[60ch] text-md text-ink-muted">{t("docs.forbiddenBody")}</p>
    </section>
  );
}

export const isForbidden = (error: unknown) =>
  error instanceof Error && error.message === "forbidden";

/** Lo scheletro della colonna di lettura: un titolo e tre blocchi grigi. */
export function ReadingSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-4 pt-8">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className="h-3 w-24 rounded-sm bg-ink/8" />
      <span className="h-6 w-2/3 rounded-sm bg-ink/8" />
      {[88, 72, 80].map((w, i) => (
        <span key={i} className="h-16 rounded-sm bg-ink/6" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
