import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useOpenPrs,
  useRepositorySettings,
  useSetReleasePipeline,
  useSetRepoPrMode,
} from "../../data/queries";
import type { RepositorySettings as Settings } from "../../data/releases";
import type { ColleaguePrMode, Project } from "../../data/types";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CloseIcon } from "../task/parts";

// Progetto → Settings → Repositories (shape releases.md §6): per ogni
// repository, cosa fa Claude sulle PR dei colleghi e come Stubwise segue i
// rilasci. Le scelte si salvano subito; «Saved» compare solo dopo la
// conferma dello store e sparisce alla modifica successiva ([R 20], la
// lezione del bug dell'area 6). Senza `repos.manage` gli stessi valori in
// sola lettura, come frasi.

type Repo = Settings["repositories"][number];
type SaveState = "idle" | "saving" | "saved";

const MODES: ColleaguePrMode[] = ["analyze_and_fix", "analyze_only", "off"];

/** «Saved» solo a salvataggio confermato; un errore lo dice. */
function useSaver() {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, setStatus] = useState<SaveState>("idle");
  const run = async (write: () => Promise<unknown>) => {
    setStatus("saving");
    try {
      await write();
      setStatus("saved");
    } catch {
      setStatus("idle");
      toast.error(t("settings.repositories.saveError"));
    }
  };
  return { status, run, reset: () => setStatus("idle") };
}

function Saved({ status }: { status: SaveState }) {
  const { t } = useTranslation();
  return (
    <span aria-live="polite" className="text-sm text-ink-muted">
      {status === "saved" ? t("settings.repositories.saved") : ""}
    </span>
  );
}

function ColleagueMode({ repo, project }: { repo: Repo; project: Project }) {
  const { t } = useTranslation();
  const set = useSetRepoPrMode();
  const prs = useOpenPrs(project.id).data;
  const saver = useSaver();
  const name = useId();
  const [asking, setAsking] = useState<ColleaguePrMode | null>(null);
  const cap = project.correctionCap ?? 3;
  const inFlight = (prs ?? []).filter(
    (p) =>
      p.repositoryId === repo.id &&
      p.origin === "colleague" &&
      p.corrections.some((c) => c.state === "running"),
  );
  const write = (mode: ColleaguePrMode) =>
    void saver.run(() => set.mutateAsync({ repositoryId: repo.id, mode }));
  const choose = (mode: ColleaguePrMode) => {
    if (mode === repo.colleaguePrs) return;
    saver.reset();
    if (mode !== "analyze_and_fix" && inFlight.length > 0) setAsking(mode);
    else write(mode);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="flex w-full items-center gap-3 pb-2 text-md font-semibold text-ink">
        {t("settings.repositories.colleagues")}
        <Saved status={saver.status} />
      </legend>
      {MODES.map((mode) => (
        <label key={mode} className="flex items-start gap-2.5">
          <input
            type="radio"
            name={name}
            checked={repo.colleaguePrs === mode}
            disabled={saver.status === "saving"}
            onChange={() => choose(mode)}
            className="mt-1 accent-ink"
          />
          <span className="flex flex-col">
            <span className="text-md text-ink">{t(`settings.repositories.modes.${mode}`)}</span>
            <span className="text-sm text-ink-muted">
              {t(`settings.repositories.modeBody.${mode}`, { code: project.code, cap })}
            </span>
          </span>
        </label>
      ))}
      <p className="text-xs text-ink-muted">
        {t("settings.repositories.stubwisePrs", { code: project.code })}
      </p>
      {asking && (
        <Dialog
          title={t("settings.repositories.stopTitle", { count: inFlight.length })}
          description={t("settings.repositories.stopBody", {
            count: inFlight.length,
            prs: inFlight.map((p) => `#${p.number}`).join(", "),
          })}
          width={440}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setAsking(null)}>
                {t("releases.cancel")}
              </button>
              <button
                type="button"
                className={primaryButton}
                onClick={() => {
                  write(asking);
                  setAsking(null);
                }}
              >
                {t("settings.repositories.change")}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </fieldset>
  );
}

function Pipeline({ repo }: { repo: Repo }) {
  const { t } = useTranslation();
  const set = useSetReleasePipeline();
  const saver = useSaver();
  const name = useId();
  const tokenId = useId();
  const branchId = useId();
  const [mode, setMode] = useState(repo.releasePipeline.mode);
  const [names, setNames] = useState(
    repo.releasePipeline.mode === "named" ? repo.releasePipeline.names : [],
  );
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState(repo.releaseBranch);

  const save = (next: { mode: "auto" | "named"; names: string[]; branch: string }) => {
    if (!next.branch.trim()) return;
    if (next.mode === "named" && next.names.length === 0) return;
    void saver.run(() =>
      set.mutateAsync({
        repositoryId: repo.id,
        pipeline: next.mode === "auto" ? { mode: "auto" } : { mode: "named", names: next.names },
        branch: next.branch,
      }),
    );
  };
  const setNamesAndSave = (list: string[]) => {
    saver.reset();
    setNames(list);
    save({ mode, names: list, branch });
  };
  const onTokenKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && token.trim()) {
      e.preventDefault();
      if (!names.includes(token.trim())) setNamesAndSave([...names, token.trim()]);
      setToken("");
    } else if (e.key === "Backspace" && !token && names.length > 0) {
      setNamesAndSave(names.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="flex w-full items-center gap-3 pb-2 text-md font-semibold text-ink">
          {t("settings.repositories.pipeline")}
          <Saved status={saver.status} />
        </legend>
        {(["auto", "named"] as const).map((m) => (
          <label key={m} className="flex items-start gap-2.5">
            <input
              type="radio"
              name={name}
              checked={mode === m}
              onChange={() => {
                saver.reset();
                setMode(m);
                save({ mode: m, names, branch });
              }}
              className="mt-1 accent-ink"
            />
            <span className="flex flex-col">
              <span className="text-md text-ink">
                {t(`settings.repositories.pipelineModes.${m}`)}
              </span>
              {m === "auto" && (
                <span className="text-sm text-ink-muted">
                  {t("settings.repositories.autoBody")}
                </span>
              )}
            </span>
          </label>
        ))}
        {mode === "named" && (
          <div className="flex flex-col gap-1.5 pl-6">
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-rule-strong px-2 py-1.5">
              {names.map((n) => (
                <span
                  key={n}
                  className="inline-flex h-6 items-center gap-1 rounded-md bg-ink/8 pr-1 pl-2 text-sm text-ink"
                >
                  {n}
                  <button
                    type="button"
                    aria-label={t("settings.repositories.removeName", { name: n })}
                    onClick={() => setNamesAndSave(names.filter((x) => x !== n))}
                    className="grid size-5 place-items-center rounded-sm text-ink-muted hover:bg-ink/10 hover:text-ink"
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              ))}
              <input
                id={tokenId}
                aria-label={t("settings.repositories.names")}
                value={token}
                placeholder={names.length === 0 ? t("settings.repositories.namesPlaceholder") : ""}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={onTokenKey}
                className="min-w-32 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
              />
            </div>
            {names.length === 0 && (
              <p className="text-xs text-ink-muted">{t("settings.repositories.namesEmpty")}</p>
            )}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={branchId} className="text-md font-semibold text-ink">
          {t("settings.repositories.branch")}
        </label>
        <input
          id={branchId}
          value={branch}
          onChange={(e) => {
            saver.reset();
            setBranch(e.target.value);
          }}
          onBlur={() => {
            if (branch.trim() && branch.trim() !== repo.releaseBranch)
              save({ mode, names, branch: branch.trim() });
          }}
          className={`${inputClass} max-w-64`}
        />
        <p className="text-xs text-ink-muted">{t("settings.repositories.fallback")}</p>
      </div>
    </div>
  );
}

function ReadOnly({ repo, project }: { repo: Repo; project: Project }) {
  const { t } = useTranslation();
  const p = repo.releasePipeline;
  return (
    <dl className="flex flex-col gap-1.5 text-md">
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-ink-muted">{t("settings.repositories.colleagues")}:</dt>
        <dd className="text-ink">{t(`settings.repositories.modes.${repo.colleaguePrs}`)}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-ink-muted">{t("settings.repositories.pipeline")}:</dt>
        <dd className="text-ink">
          {p.mode === "auto"
            ? t("settings.repositories.pipelineModes.auto")
            : `${t("settings.repositories.pipelineModes.named")} (${p.names.join(", ")})`}
        </dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-ink-muted">{t("settings.repositories.branch")}:</dt>
        <dd className="text-ink">{repo.releaseBranch}</dd>
      </div>
      <p className="text-xs text-ink-muted">
        {t("settings.repositories.stubwisePrs", { code: project.code })}
      </p>
    </dl>
  );
}

export function RepositorySettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const settings = useRepositorySettings(project.id);
  const data = settings.data;
  return (
    <section aria-labelledby="settings-repositories" className="border-t border-rule pt-5 pb-7">
      <h2 id="settings-repositories" className="text-xl font-semibold text-ink">
        {t("settings.repositories.title")}
      </h2>
      <p className="max-w-[72ch] pt-1 pb-4 text-md text-ink-muted">
        {t("settings.repositories.intro")}
      </p>
      {settings.isError ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-md text-ink">{t("settings.repositories.error")}</p>
          <button type="button" className={secondaryButton} onClick={() => void settings.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="text-sm text-ink-muted">
          {t("taskUi.states.loading")}
        </p>
      ) : data.repositories.length === 0 ? (
        <p className="text-md text-ink-muted">
          {t("releases.empty.noRepos", { code: project.code })}
        </p>
      ) : (
        <ul className="flex flex-col">
          {data.repositories.map((repo) => (
            <li
              key={repo.id}
              data-repository={repo.fullName}
              className="flex flex-col gap-5 border-t border-rule py-5"
            >
              <p className="flex items-baseline gap-2">
                <span className="num text-sm font-semibold text-ink">{repo.fullName}</span>
                <span className="text-sm text-ink-muted">
                  {repo.ciProvider === "bitbucket_pipelines" ? "Bitbucket" : "GitHub"}
                </span>
              </p>
              {data.canManage ? (
                <>
                  <ColleagueMode repo={repo} project={project} />
                  <Pipeline repo={repo} />
                </>
              ) : (
                <ReadOnly repo={repo} project={project} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
