import { Link } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  reviewAccountChoices,
  useGitAccounts,
  useProjectRepositories,
  useUpdateRepository,
  type RepositoryView,
} from "../../../data/queries";
import type { Project } from "../../../data/types";
import { AiSkeleton } from "../../admin/ai/parts";
import { SaveBar } from "../../admin/parts";
import { selectClass } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { useFlash } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
import { RepositoryReleases } from "../RepositorySettings";
import { LeaveConfirm, SettingsFrame, useLeaveGuard, useSettingsWrite } from "../SettingsFrame";
import { ViewOnlyLine } from "../ViewOnly";
import { WebhookSection, WebhookState } from "./WebhookRow";

// La pagina di un repository (`?repo=<id>`, shape project-repositories.md
// «La pagina del repository»): la testata col webhook in parole, i DETAILS
// da modificare con la barra di salvataggio in fondo, il WEBHOOK e, col
// modulo Releases, le parti dell'8a. Il ramo predefinito si legge e basta:
// è un fatto della piattaforma (ruling del controller (pre-flight), P27).
// Le regole le dice il livello dati: le scelte dell'account di revisione
// (`reviewAccountChoices`), la frase sotto il campo dal rifiuto, la riga
// sbagliata dei rami protetti dal rifiuto (`line`). Senza `repos.manage`:
// la riga ○ in testa e i campi come testo.

const fieldBase =
  "w-full rounded-md border border-rule-strong bg-transparent px-2.5 text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent aria-invalid:border-critical";
const fieldClass = `${fieldBase} text-md`;
/** Un campo di codice (comandi, rami): monospace; il segnaposto resta prosa. */
const codeFieldClass = `${fieldBase} font-code placeholder:font-sans placeholder:text-sm`;

interface Draft {
  name: string;
  url: string;
  gitAccountId: string | null;
  reviewGitAccountId: string | null;
  testCommand: string;
  installCommand: string;
  graphEnabled: boolean;
  protectedText: string;
}

const draftOf = (r: RepositoryView): Draft => ({
  name: r.name,
  url: r.url,
  gitAccountId: r.gitAccount?.id ?? null,
  reviewGitAccountId: r.reviewAccount?.id ?? null,
  testCommand: r.testCommand ?? "",
  installCommand: r.installCommand ?? "",
  graphEnabled: r.graphEnabled,
  protectedText: r.protectedBranches.join("\n"),
});

/** Le righe dell'area, una per ramo; le righe vuote in fondo non contano (un a capo finale). */
const branchLines = (text: string): string[] => {
  const lines = text.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
};

type Invalid = { reason: string; line?: number } | null;

export function RepositoryEditor({
  project,
  repositoryId,
  onBack,
}: {
  project: Project;
  repositoryId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const repositories = useProjectRepositories(project.id);
  const data = repositories.data;
  const repository = data?.repositories.find((r) => r.id === repositoryId);
  const back = <BackLink code={project.code} onBack={onBack} />;
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);

  if (repositories.isPending)
    return (
      <SettingsFrame title={t("settings.sections.repositories")} back={back}>
        <AiSkeleton rows={6} height={52} />
      </SettingsFrame>
    );
  if (repositories.isError)
    return (
      <SettingsFrame title={t("settings.sections.repositories")} back={back}>
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
      </SettingsFrame>
    );
  if (!data || !repository)
    return (
      <SettingsFrame title={t("settings.sections.repositories")} back={back}>
        <p className="border-t border-rule py-4 text-md text-ink-muted">
          {t("settings.repos.notFound", { code: project.code })}
        </p>
      </SettingsFrame>
    );

  const platform = repository.provider
    ? t(`settings.repos.platforms.${repository.provider}`)
    : null;
  return (
    <SettingsFrame
      title={repository.name}
      back={back}
      action={<WebhookState state={repository.webhook.state} />}
      intro={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm">{repository.fullName}</span>
          {platform && (
            <>
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <span>{platform}</span>
            </>
          )}
          {repository.url && (
            <>
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <code title={repository.url} className="min-w-0 font-code [overflow-wrap:anywhere]">
                {repository.url}
              </code>
            </>
          )}
        </span>
      }
    >
      <Details
        project={project}
        repository={repository}
        canManage={data.canManage}
        barSlot={barSlot}
        onReload={() => void repositories.refetch()}
      />
      <WebhookSection
        repository={repository}
        canManage={data.canManage}
        projectId={project.id}
        code={project.code}
        onReload={() => void repositories.refetch()}
      />
      {project.modules.includes("releases") && (
        <ReleasesSection project={project} repositoryId={repository.id} />
      )}
      {/* Il posto della barra di salvataggio: figlia della colonna, così `sticky` la tiene in fondo su tutta la pagina. */}
      <div ref={setBarSlot} className="contents" />
    </SettingsFrame>
  );
}

function BackLink({ code, onBack }: { code: string; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/p/$code/settings/$section"
      params={{ code, section: "repositories" }}
      search={((prev: Record<string, unknown>) => ({ ...prev, repo: undefined })) as never}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        onBack();
      }}
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
    >
      <svg
        viewBox="0 0 16 16"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
      </svg>
      {t("settings.repos.back")}
    </Link>
  );
}

function ReleasesSection({ project, repositoryId }: { project: Project; repositoryId: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="heading-group border-b border-rule pb-2">
        {t("settings.repos.releases")}
      </h2>
      <RepositoryReleases project={project} repositoryId={repositoryId} />
    </section>
  );
}

function Details({
  project,
  repository,
  canManage,
  barSlot,
  onReload,
}: {
  project: Project;
  repository: RepositoryView;
  canManage: boolean;
  barSlot: HTMLElement | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const lineId = useId();
  const accounts = useGitAccounts();
  const write = useSettingsWrite(project.code, onReload);
  const initial = draftOf(repository);

  // Il revisore predefinito e le scelte, dal livello dati (sugli account letti).
  const accountList = accounts.data ?? [];
  const review = reviewAccountChoices(accountList, initial.gitAccountId);
  const reviewReading = repository.reviewAccount
    ? repository.reviewAccount.name
    : review.defaultReviewer
      ? t("settings.repos.reviewDefault", { name: review.defaultReviewer.name })
      : accounts.data
        ? t("settings.repos.reviewNoDefault")
        : "—";

  return (
    <section aria-labelledby={headingId}>
      {!canManage && (
        <>
          {write.lost && <div className="pb-3">{write.message}</div>}
          <ViewOnlyLine
            id={lineId}
            action="manageRepos"
            projectId={project.id}
            code={project.code}
          />
        </>
      )}
      <h2 id={headingId} className="heading-group border-b border-rule pb-2">
        {t("settings.repos.details")}
      </h2>
      {canManage ? (
        <DetailsForm
          project={project}
          repository={repository}
          initial={initial}
          accounts={accountList}
          write={write}
          barSlot={barSlot}
        />
      ) : (
        <dl className="@container">
          <Row label={t("settings.repos.fields.name")}>
            <dd className="text-md text-ink @min-[720px]:pt-1.5">{repository.name}</dd>
          </Row>
          <Row label={t("settings.repos.fields.address")}>
            <dd className="font-code text-ink [overflow-wrap:anywhere] @min-[720px]:pt-2">
              {repository.url}
            </dd>
          </Row>
          <Row label={t("settings.repos.fields.defaultBranch")}>
            <dd className="font-code text-ink @min-[720px]:pt-2">{repository.defaultBranch}</dd>
          </Row>
          <Row label={t("settings.repos.fields.gitAccount")}>
            <dd
              className={`text-md @min-[720px]:pt-1.5 ${repository.gitAccount ? "text-ink" : "text-ink-faint"}`}
            >
              {repository.gitAccount?.name ?? t("settings.repos.noAccount")}
            </dd>
          </Row>
          <Row label={t("settings.repos.fields.reviewAccount")}>
            <dd className="text-md text-ink @min-[720px]:pt-1.5">{reviewReading}</dd>
          </Row>
          <Row label={t("settings.repos.fields.testCommand")}>
            <CommandReading value={repository.testCommand} />
          </Row>
          <Row label={t("settings.repos.fields.installCommand")}>
            <CommandReading value={repository.installCommand} />
          </Row>
          <Row label={t("settings.repos.fields.graph")}>
            <dd className="text-md text-ink @min-[720px]:pt-1.5">
              {repository.graphEnabled ? t("settings.repos.graphOn") : t("settings.repos.graphOff")}
            </dd>
          </Row>
          <Row label={t("settings.repos.fields.protected")}>
            <dd className="@min-[720px]:pt-2">
              {repository.protectedBranches.length === 0 ? (
                <span className="text-md text-ink-muted">{t("settings.repos.protectedNone")}</span>
              ) : (
                <ul className="flex flex-col gap-0.5 font-code text-ink">
                  {repository.protectedBranches.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </dd>
          </Row>
        </dl>
      )}
    </section>
  );
}

function CommandReading({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return (
    <dd className="@min-[720px]:pt-2">
      {value ? (
        <code className="font-code text-ink">{value}</code>
      ) : (
        <span className="text-md text-ink-muted">{t("settings.repos.commandPlaceholder")}</span>
      )}
    </dd>
  );
}

function DetailsForm({
  project,
  repository,
  initial,
  accounts,
  write,
  barSlot,
}: {
  project: Project;
  repository: RepositoryView;
  initial: Draft;
  accounts: {
    id: string;
    name: string;
    provider: "github" | "bitbucket";
    workspace: string | null;
    defaultReviewer: boolean;
  }[];
  write: ReturnType<typeof useSettingsWrite>;
  barSlot: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const update = useUpdateRepository();
  const [edits, setEdits] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<Invalid>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash();
  const id = useId();
  const draft = edits ?? initial;
  const set = (patch: Partial<Draft>) => {
    setEdits({ ...draft, ...patch });
    setInvalid(null);
  };

  const sameLines = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const changed = {
    name: draft.name !== initial.name,
    url: draft.url !== initial.url,
    gitAccountId: draft.gitAccountId !== initial.gitAccountId,
    reviewGitAccountId: draft.reviewGitAccountId !== initial.reviewGitAccountId,
    testCommand: draft.testCommand !== initial.testCommand,
    installCommand: draft.installCommand !== initial.installCommand,
    graphEnabled: draft.graphEnabled !== initial.graphEnabled,
    protectedBranches: !sameLines(
      branchLines(draft.protectedText),
      branchLines(initial.protectedText),
    ),
  };
  const changes = Object.values(changed).filter(Boolean).length;
  const guard = useLeaveGuard(changes > 0);

  // Le scelte dell'account di revisione per l'account principale della bozza.
  const main = accounts.find((a) => a.id === draft.gitAccountId);
  const mainPlatform = main ? t(`settings.repos.platforms.${main.provider}`) : "";
  const review = reviewAccountChoices(accounts, draft.gitAccountId);
  // Gli account, anche quello attuale se la lettura degli account non è arrivata.
  const accountOptions =
    accounts.length > 0 ? accounts : repository.gitAccount ? [{ ...repository.gitAccount }] : [];

  async function submit() {
    if (changes === 0 || busy) return;
    setBusy(true);
    setInvalid(null);
    const ok = await write.run(
      () =>
        update.mutateAsync({
          repositoryId: repository.id,
          ...(changed.name ? { name: draft.name } : {}),
          ...(changed.url ? { url: draft.url } : {}),
          ...(changed.gitAccountId && draft.gitAccountId
            ? { gitAccountId: draft.gitAccountId }
            : {}),
          ...(changed.reviewGitAccountId ? { reviewGitAccountId: draft.reviewGitAccountId } : {}),
          ...(changed.testCommand ? { testCommand: draft.testCommand } : {}),
          ...(changed.installCommand ? { installCommand: draft.installCommand } : {}),
          ...(changed.graphEnabled ? { graphEnabled: draft.graphEnabled } : {}),
          ...(changed.protectedBranches
            ? { protectedBranches: branchLines(draft.protectedText) }
            : {}),
        }),
      (reason, line) => setInvalid({ reason, line }),
    );
    setBusy(false);
    if (!ok) return;
    guard.clear();
    setEdits(null);
    flash();
  }

  const errorOf = (reasons: string[]) =>
    invalid && reasons.includes(invalid.reason) ? invalid : null;
  const nameError = errorOf(["name", "name_taken"]);
  const urlError = errorOf(["url"]);
  const accountError = errorOf(["git_account"]);
  const reviewError = errorOf(["review_account"]);
  const protectedError = errorOf(["protected_branch"]);
  const describe = (...ids: (string | false | null)[]) =>
    ids.filter(Boolean).join(" ") || undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="contents"
    >
      <dl className="@container">
        <Row label={t("settings.repos.fields.name")} htmlFor={`${id}-name`}>
          <dd className="flex flex-col gap-1.5">
            <input
              id={`${id}-name`}
              value={draft.name}
              spellCheck={false}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={describe(`${id}-name-hint`, nameError && `${id}-name-error`)}
              onChange={(e) => set({ name: e.target.value })}
              className={`${fieldClass} h-9`}
            />
            <p id={`${id}-name-hint`} className="text-xs text-ink-muted">
              {t("settings.repos.nameHint", {
                code: project.code,
                name: draft.name.trim() || repository.name,
              })}
            </p>
            {nameError && (
              <ErrorLine id={`${id}-name-error`}>
                {nameError.reason === "name_taken"
                  ? t("settings.repos.nameTaken", { code: project.code, name: draft.name.trim() })
                  : t("settings.repos.nameInvalid")}
              </ErrorLine>
            )}
          </dd>
        </Row>
        <Row label={t("settings.repos.fields.address")} htmlFor={`${id}-url`}>
          <dd className="flex flex-col gap-1.5">
            <input
              id={`${id}-url`}
              type="url"
              value={draft.url}
              spellCheck={false}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlError ? `${id}-url-error` : undefined}
              onChange={(e) => set({ url: e.target.value })}
              className={`${fieldClass} h-9`}
            />
            {urlError && (
              <ErrorLine id={`${id}-url-error`}>{t("settings.repos.addressError")}</ErrorLine>
            )}
          </dd>
        </Row>
        <PairRow
          first={{
            label: t("settings.repos.fields.defaultBranch"),
            content: (
              <dd className="flex flex-col gap-1 @min-[720px]:pt-2">
                <span className="font-code text-ink">{repository.defaultBranch}</span>
                {repository.provider && (
                  <span className="text-xs text-ink-muted">
                    {t("settings.repos.defaultBranchHint", {
                      platform: t(`settings.repos.platforms.${repository.provider}`),
                    })}
                  </span>
                )}
              </dd>
            ),
          }}
          second={{
            label: t("settings.repos.fields.gitAccount"),
            htmlFor: `${id}-account`,
            content: (
              <dd className="flex flex-col gap-1.5">
                <select
                  id={`${id}-account`}
                  value={draft.gitAccountId ?? ""}
                  aria-invalid={accountError ? true : undefined}
                  aria-describedby={accountError ? `${id}-account-error` : undefined}
                  onChange={(e) => set({ gitAccountId: e.target.value })}
                  className={`${selectClass} h-9 w-full`}
                >
                  {draft.gitAccountId === null && (
                    <option value="">{t("settings.repos.noAccount")}</option>
                  )}
                  {accountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {accountError && (
                  <ErrorLine id={`${id}-account-error`}>
                    {t("settings.repos.gitAccountError")}
                  </ErrorLine>
                )}
              </dd>
            ),
          }}
        />
        <Row label={t("settings.repos.fields.reviewAccount")} htmlFor={`${id}-review`}>
          <dd className="flex flex-col gap-1.5">
            <select
              id={`${id}-review`}
              value={draft.reviewGitAccountId ?? ""}
              aria-invalid={reviewError ? true : undefined}
              aria-describedby={describe(`${id}-review-hint`, reviewError && `${id}-review-error`)}
              onChange={(e) =>
                set({ reviewGitAccountId: e.target.value === "" ? null : e.target.value })
              }
              className={`${selectClass} h-9 w-full max-w-[420px]`}
            >
              <option value="">
                {review.defaultReviewer
                  ? t("settings.repos.reviewDefault", { name: review.defaultReviewer.name })
                  : t("settings.repos.reviewNoDefault")}
              </option>
              {review.choices.map((c) => (
                <option key={c.id} value={c.id} disabled={c.unavailable !== null}>
                  {c.unavailable
                    ? `${c.name} · ${t(`settings.repos.reviewUnavailable.${c.unavailable}`, { platform: mainPlatform })}`
                    : c.name}
                </option>
              ))}
            </select>
            <p id={`${id}-review-hint`} className="max-w-[64ch] text-xs text-ink-muted">
              {t("settings.repos.reviewHint")}
            </p>
            {reviewError && (
              <ErrorLine id={`${id}-review-error`}>
                {t("settings.repos.reviewError", { platform: mainPlatform })}
              </ErrorLine>
            )}
          </dd>
        </Row>
        {(["testCommand", "installCommand"] as const).map((field) => (
          <Row key={field} label={t(`settings.repos.fields.${field}`)} htmlFor={`${id}-${field}`}>
            <dd>
              <input
                id={`${id}-${field}`}
                value={draft[field]}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("settings.repos.commandPlaceholder")}
                onChange={(e) => set({ [field]: e.target.value })}
                className={`${codeFieldClass} h-9`}
              />
            </dd>
          </Row>
        ))}
        <Row label={t("settings.repos.fields.graph")}>
          <dd className="flex items-start gap-3 @min-[720px]:pt-2">
            <span className="flex h-5 shrink-0 items-center">
              <Switch
                checked={draft.graphEnabled}
                label={t("settings.repos.fields.graph")}
                describedBy={`${id}-graph`}
                onChange={(on) => set({ graphEnabled: on })}
              />
            </span>
            <span id={`${id}-graph`} className="max-w-[60ch] text-sm text-pretty text-ink-muted">
              {t("settings.repos.graphBody")}
            </span>
          </dd>
        </Row>
        <Row label={t("settings.repos.fields.protected")} htmlFor={`${id}-protected`}>
          <dd className="flex flex-col gap-1.5">
            <textarea
              id={`${id}-protected`}
              rows={3}
              value={draft.protectedText}
              spellCheck={false}
              aria-invalid={protectedError ? true : undefined}
              aria-describedby={describe(
                `${id}-protected-hint`,
                protectedError && `${id}-protected-error`,
              )}
              onChange={(e) => set({ protectedText: e.target.value })}
              className={`${codeFieldClass} max-h-[220px] min-h-[76px] resize-none py-2 leading-5 [field-sizing:content]`}
            />
            <p
              id={`${id}-protected-hint`}
              className="max-w-[64ch] text-xs text-pretty text-ink-muted"
            >
              {t("settings.repos.protectedHint")}
            </p>
            {protectedError && (
              <ErrorLine id={`${id}-protected-error`}>
                {t("settings.repos.protectedError", { line: protectedError.line ?? 1 })}
              </ErrorLine>
            )}
          </dd>
        </Row>
      </dl>
      {barSlot &&
        (changes > 0 || justSaved || write.message) &&
        createPortal(
          <FocusRescue>
            <SaveBar width={880} inset="-mx-8 mt-6 px-8" data={{ "data-save-bar": "" }}>
              {write.message}
              {guard.blocked && changes > 0 ? (
                <LeaveConfirm guard={guard} />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  {changes > 0 ? (
                    <p className="num min-w-0 flex-1 text-sm text-ink">
                      {t("settings.repos.changes", { count: changes })}
                    </p>
                  ) : (
                    <p role="status" className="min-w-0 flex-1 text-sm text-ink">
                      {justSaved ? t("settings.common.saved") : ""}
                    </p>
                  )}
                  {changes > 0 && (
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => {
                        setEdits(null);
                        setInvalid(null);
                      }}
                    >
                      {t("settings.common.discard")}
                    </button>
                  )}
                  {/* Resta montato dopo il salvataggio, spento: il fuoco non cade sul body. */}
                  <button
                    type="button"
                    aria-disabled={busy || changes === 0 || undefined}
                    className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
                    onClick={() => void submit()}
                  >
                    {t("settings.common.save")}
                  </button>
                </div>
              )}
            </SaveBar>
          </FocusRescue>,
          barSlot,
        )}
    </form>
  );
}

/**
 * La barra se ne va 2 s dopo «Saved»: se il fuoco era dentro (su Save),
 * passa all'h1 della pagina invece di cadere sul body.
 */
function FocusRescue({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && el.contains(document.activeElement))
        el.closest("section")?.querySelector<HTMLElement>("h1")?.focus();
    };
  }, []);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}

/** Una riga del modulo: etichetta a sinistra (160 px) da larga, sopra il campo da stretta. */
function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule py-3.5 @min-[720px]:grid @min-[720px]:grid-cols-[160px_minmax(0,1fr)] @min-[720px]:gap-x-6">
      <dt className="text-sm font-medium text-ink @min-[720px]:pt-2">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
      </dt>
      {children}
    </div>
  );
}

/** Due campi brevi sulla stessa riga da larga (ramo · account), uno per riga da stretta. */
function PairRow({
  first,
  second,
}: {
  first: { label: string; htmlFor?: string; content: ReactNode };
  second: { label: string; htmlFor?: string; content: ReactNode };
}) {
  const label = (f: { label: string; htmlFor?: string }) => (
    <dt className="text-sm font-medium text-ink @min-[720px]:pt-2">
      {f.htmlFor ? <label htmlFor={f.htmlFor}>{f.label}</label> : f.label}
    </dt>
  );
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule py-3.5 @min-[720px]:grid @min-[720px]:grid-cols-[160px_minmax(0,1fr)_112px_minmax(0,1fr)] @min-[720px]:gap-x-6">
      <div className="contents">
        {label(first)}
        {first.content}
      </div>
      <div className="mt-3 flex flex-col gap-1.5 @min-[720px]:contents">
        {label(second)}
        {second.content}
      </div>
    </div>
  );
}
