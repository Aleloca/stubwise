import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useProjectRepositories, type RepositoryView } from "../../../data/queries";
import type { Project } from "../../../data/types";
import { useToast } from "../../../tasks-ui/Toast";
import { AiSkeleton } from "../../admin/ai/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { SettingsFrame } from "../SettingsFrame";
import { ViewOnlyLine } from "../ViewOnly";
import { NewRepositoryWizard } from "./NewRepositoryWizard";
import { RepositoryEditor } from "./RepositoryEditor";
import { RepositoriesReleasesOnly } from "./RepositoriesReleasesOnly";
import { isAppBuild } from "../../../data/build";
import { WebhookState } from "./WebhookRow";

// Progetto → Settings → Repositories (area 9c, Task 8, shape
// project-repositories.md): l'elenco, la creazione guidata (`?new=1`) e la
// pagina di un repository (`?repo=<id>`), come `addMember` del 9a. Chi
// scrive lo dice la lettura (`canManage`), mai un controllo qui. Senza
// `repos.manage`: la riga ○ in testa e «Add repository» spento con la sua
// frase e «Who?». Nessuna eliminazione: un repository lascia un progetto
// solo con il progetto [RE 2].

/** Quanto resta evidenziata la riga appena creata. */
const ADDED_MS = 2000;

type Search = { new?: string; repo?: string };

export function RepositoriesSection({ project }: { project: Project }) {
  const search = useSearch({ strict: false }) as Search;
  const navigate = useNavigate();
  const setSearch = (patch: Search) =>
    void navigate({
      to: "/p/$code/settings/$section",
      params: { code: project.code, section: "repositories" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never,
    });
  // Build app (area 8, F1, 46): la sezione ridotta al solo blocco «Releases».
  if (isAppBuild())
    return (
      <RepositoriesReleasesOnly
        project={project}
        repositoryId={search.repo}
        open={(repo) => setSearch({ repo })}
      />
    );
  if (search.repo)
    return (
      <RepositoryEditor
        // Un repository diverso è una pagina nuova: la bozza non passa dall'uno all'altro.
        key={search.repo}
        project={project}
        repositoryId={search.repo}
        onBack={() => setSearch({ repo: undefined })}
      />
    );
  return <RepositoryList project={project} wizardOpen={search.new === "1"} setSearch={setSearch} />;
}

function RepositoryList({
  project,
  wizardOpen,
  setSearch,
}: {
  project: Project;
  wizardOpen: boolean;
  setSearch: (patch: Search) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const repositories = useProjectRepositories(project.id);
  const data = repositories.data;
  const canManage = data?.canManage === true;
  const lineId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [added, setAdded] = useState<string | null>(null);
  // Dove va il fuoco quando il dialogo si chiude: «Add repository» o la riga nuova.
  const [focusAfter, setFocusAfter] = useState<"add" | { row: string } | null>(null);

  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(null), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [added]);

  useEffect(() => {
    if (wizardOpen || !focusAfter) return;
    if (focusAfter === "add") {
      addRef.current?.focus();
      setFocusAfter(null);
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-repository-row="${focusAfter.row}"]`,
    );
    if (!row) return; // la lettura nuova non è ancora arrivata
    row.focus();
    setFocusAfter(null);
  }, [wizardOpen, focusAfter, data]);

  const open = () => {
    if (canManage) setSearch({ new: "1" });
  };
  const addButton = data ? (
    <span className="flex shrink-0 items-center gap-2">
      {!canManage && (
        <WhoCanLink action="manageRepos" projectId={project.id} projectCode={project.code} />
      )}
      <button
        ref={addRef}
        type="button"
        aria-disabled={!canManage || undefined}
        aria-describedby={canManage ? undefined : lineId}
        onClick={open}
        className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
      >
        {t("settings.repos.add")}
      </button>
    </span>
  ) : null;

  return (
    <SettingsFrame
      title={t("settings.sections.repositories")}
      intro={t("settings.repos.intro", { code: project.code })}
      action={addButton}
    >
      {data && !canManage && (
        <ViewOnlyLine id={lineId} action="manageRepos" projectId={project.id} code={project.code} />
      )}
      {repositories.isPending ? (
        <AiSkeleton rows={3} height={60} />
      ) : repositories.isError || !data ? (
        <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
          <p className="text-md text-ink">
            {t("settings.repos.loadError", { code: project.code })}
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => void repositories.refetch()}
          >
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : data.repositories.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border-t border-rule py-8">
          <p className="max-w-[60ch] text-md text-pretty text-ink-muted">
            {t("settings.repos.empty", { code: project.code })}
          </p>
          {canManage ? (
            <button type="button" className={secondaryButton} onClick={open}>
              {t("settings.repos.add")}
            </button>
          ) : (
            <p className="text-sm text-ink-muted">
              {t("settings.repos.emptyRead", { code: project.code })}{" "}
              <WhoCanLink action="manageRepos" projectId={project.id} projectCode={project.code} />
            </p>
          )}
        </div>
      ) : (
        <ul
          ref={listRef}
          aria-label={t("settings.repos.list", { code: project.code })}
          className="border-t border-rule"
        >
          {data.repositories.map((r) => (
            <RepositoryRow key={r.id} project={project} repository={r} justAdded={added === r.id} />
          ))}
        </ul>
      )}
      {data && <p className="mt-4 text-xs text-ink-faint">{t("settings.repos.leaves")}</p>}
      {wizardOpen && canManage && (
        <NewRepositoryWizard
          project={project}
          onClose={() => {
            setFocusAfter("add");
            setSearch({ new: undefined });
          }}
          onCreated={(id, name) => {
            setAdded(id);
            setFocusAfter({ row: id });
            setSearch({ new: undefined });
            toast.show(t("settings.repos.added", { name, code: project.code }), {
              action: { label: t("settings.repos.open"), run: () => setSearch({ repo: id }) },
            });
          }}
        />
      )}
    </SettingsFrame>
  );
}

function RepositoryRow({
  project,
  repository: r,
  justAdded,
}: {
  project: Project;
  repository: RepositoryView;
  justAdded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="border-b border-rule">
      <Link
        to="/p/$code/settings/$section"
        params={{ code: project.code, section: "repositories" }}
        search={
          ((prev: Record<string, unknown>) => ({ ...prev, repo: r.id, new: undefined })) as never
        }
        data-repository-row={r.id}
        data-just-added={justAdded || undefined}
        className={`group -mx-2 flex min-h-[60px] items-center gap-4 rounded-md px-2 py-2.5 transition-colors duration-[var(--duration)] ease-out hover:bg-ink/4 ${
          justAdded ? "bg-ink/6" : ""
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span title={r.name} className="truncate text-md font-semibold text-ink">
              {r.name}
            </span>
            <span title={r.fullName} className="truncate text-sm text-ink-muted">
              {r.fullName}
            </span>
            {r.provider && (
              <span className="shrink-0 text-sm text-ink-muted">
                {t(`settings.repos.platforms.${r.provider}`)}
              </span>
            )}
          </span>
          <span className="truncate text-sm text-ink-muted">
            {r.releaseBranch}
            {" · "}
            {r.gitAccount?.name ?? (
              <span className="text-ink-faint">{t("settings.repos.noAccount")}</span>
            )}
            {" · "}
            {r.testCommand ? (
              <>
                {t("settings.repos.tests")}{" "}
                <code className="font-code text-ink">{r.testCommand}</code>
              </>
            ) : (
              t("settings.repos.testsDetected")
            )}
          </span>
        </span>
        <WebhookState state={r.webhook.state} />
        <span className="shrink-0 text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out group-hover:text-ink">
          <svg
            viewBox="0 0 16 16"
            width={14}
            height={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 8h9.5M8.5 4l4 4-4 4" />
          </svg>
        </span>
      </Link>
    </li>
  );
}
