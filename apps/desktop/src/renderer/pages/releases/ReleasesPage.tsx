import { Link, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useEnvironments,
  useOpenPrs,
  useProject,
  useReleaseQueue,
  useReleases,
  useRepositorySettings,
  useSessionPersonId,
} from "../../data/queries";
import { PageEmpty, PageSkeleton } from "../../tasks-ui/PageStates";
import { smallSecondary } from "../task/parts";
import { Environments } from "./Environments";
import { NeedsAttention, attentionCases } from "./NeedsAttention";
import { PrList } from "./PrList";
import { ReleaseList } from "./ReleaseList";

// La sezione Releases di un progetto (`#/p/AUD/releases`, shape releases.md
// §3 e §6): una pagina che scorre — «Needs attention» se serve, le PR in una
// lista a due gruppi, i rilasci, gli ambienti. Ogni parte ha i suoi stati:
// l'errore di una non abbatte le altre. `?view=prs|releases|environments` è
// l'elenco intero di una parte ([R 3]); `?pr=` il pannello (layout).
// Stubwise mergia, la pipeline rilascia: nessun bottone primario di pagina.

type View = "prs" | "releases" | "environments";

function Part({
  id,
  title,
  count,
  action,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col">
      <div className="flex min-h-8 items-center gap-2 pb-2">
        <h2 id={`${id}-title`} className="flex items-baseline gap-2 text-xl font-semibold text-ink">
          {title}
          {count !== undefined && count > 0 && (
            <span className="num text-md font-normal text-ink-faint">{count}</span>
          )}
        </h2>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function PartError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center gap-3 border-t border-rule py-3 pl-3">
      <p className="text-md text-ink">{message}</p>
      <button type="button" className={smallSecondary} onClick={retry}>
        {t("taskUi.states.retry")}
      </button>
    </div>
  );
}

const loading = (rows: number) => (
  <div className="border-t border-rule">
    <PageSkeleton rows={rows} />
  </div>
);

export function ReleasesPage({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const search = useSearch({ strict: false }) as { view?: string };
  const view: View | null =
    search.view === "prs" || search.view === "releases" || search.view === "environments"
      ? search.view
      : null;
  const project = useProject(projectCode).data ?? undefined;
  const prs = useOpenPrs(project?.id);
  const queue = useReleaseQueue(project?.id);
  const releases = useReleases(project?.id);
  const envs = useEnvironments(project?.id);
  const cap = project?.correctionCap ?? 3;

  const repos = useRepositorySettings(project?.id);
  // Il rimando «Set up environments» arriva con `#environments`: la parte si porta in vista.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const envsReady = envs.data !== undefined;
  useEffect(() => {
    if (hash === "environments" && envsReady) {
      document.getElementById("environments")?.scrollIntoView?.({ block: "start" });
    }
  }, [hash, envsReady]);

  const prsPart = (
    <Part id="prs" title={t("releases.parts.prs")} count={prs.data?.length}>
      {prs.isError || queue.isError ? (
        <PartError
          message={t("releases.errors.prs")}
          retry={() => {
            if (prs.isError) void prs.refetch();
            if (queue.isError) void queue.refetch();
          }}
        />
      ) : !prs.data || !queue.data ? (
        loading(3)
      ) : prs.data.length === 0 ? (
        <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
          {t("releases.empty.prs", { code: projectCode })}
        </p>
      ) : (
        <PrList
          projectCode={projectCode}
          prs={prs.data}
          queue={queue.data}
          cap={cap}
          environments={envs.data?.environments ?? []}
          full={view === "prs"}
        />
      )}
    </Part>
  );

  const releasesPart = (
    <Part id="releases-part" title={t("releases.parts.releases")} count={releases.data?.length}>
      {releases.isError ? (
        <PartError message={t("releases.errors.releases")} retry={() => void releases.refetch()} />
      ) : !releases.data ? (
        loading(3)
      ) : releases.data.length === 0 ? (
        <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
          {t("releases.empty.releases")}
        </p>
      ) : (
        <ReleaseList
          releases={releases.data}
          projectCode={projectCode}
          full={view === "releases"}
        />
      )}
    </Part>
  );

  const envsPart = (
    <Part
      id="environments"
      title={t("releases.parts.environments")}
      count={envs.data?.environments.length}
    >
      {envs.isError ? (
        <PartError message={t("releases.errors.environments")} retry={() => void envs.refetch()} />
      ) : !envs.data || !project ? (
        loading(2)
      ) : (
        <Environments
          projectId={project.id}
          projectCode={projectCode}
          canManage={envs.data.canManage}
          environments={envs.data?.environments ?? []}
          releases={releases.data ?? []}
        />
      )}
    </Part>
  );

  const noRepos = repos.data?.repositories.length === 0;
  const cases = releases.data && prs.data ? attentionCases(releases.data, prs.data, me) : [];

  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col gap-8 pr-8">
        <header className="page-header flex shrink-0 flex-col gap-1.5 [--page-header-pr:32px] [--page-header-pt:32px]">
          {view ? (
            <p className="text-sm text-ink-muted">
              <Link
                to="/p/$code/$section"
                params={{ code: projectCode, section: "releases" }}
                className="rounded-sm underline-offset-4 hover:text-ink hover:underline"
              >
                {t("releases.title")}
              </Link>
            </p>
          ) : null}
          <h1 className="text-2xl font-semibold text-ink">
            {view ? t(`releases.parts.${view}`) : t("releases.title")}
          </h1>
          {!view && (
            <p className="max-w-[72ch] text-md text-ink-muted">
              {t("releases.subtitle", { code: projectCode })}
            </p>
          )}
        </header>
        {noRepos ? (
          <PageEmpty title={t("releases.empty.noRepos", { code: projectCode })} />
        ) : view === "prs" ? (
          prsPart
        ) : view === "releases" ? (
          releasesPart
        ) : view === "environments" ? (
          envsPart
        ) : (
          <>
            <NeedsAttention cases={cases} />
            {prsPart}
            {releasesPart}
            {envsPart}
          </>
        )}
      </div>
    </section>
  );
}
