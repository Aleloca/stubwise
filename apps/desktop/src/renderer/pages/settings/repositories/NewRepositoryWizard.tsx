import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import {
  useCheckRepositoryAccess,
  useCreateRepository,
  useGitAccounts,
  useRemoteRepositories,
  useSeesGitAccounts,
  useSimulateNextRepositoryCheck,
  type GitAccountView,
  type TestOutcome,
} from "../../../data/queries";
import type { Project } from "../../../data/types";
import { Dialog, DialogField, inputClass } from "../../../tasks-ui/Dialog";
import { AiSkeleton } from "../../admin/ai/parts";
import { CHECK_MS, CheckWords, CrossGlyph, wait } from "../../admin/integrations/parts";
import { PrototypeBox } from "../../automations/shared";
import { Segmented, selectClass } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { CheckGlyph } from "../../preferences/glyphs";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { useSettingsWrite } from "../SettingsFrame";

// La creazione guidata di un repository (shape project-repositories.md, «La
// creazione guidata», [RE 3]): un dialogo da 720 px con i passi numerati a
// sinistra (a finestra stretta, 656 px e i passi in riga sopra). Account
// git, repository, ramo, verifica degli accessi; i comandi compaiono solo
// dopo una verifica riuscita, e «Create» si accende solo con quella della
// STESSA terna: cambiarne un pezzo azzera la verifica. Il ramo scelto è
// quello delle PR (`releaseBranch`), il predefinito viene dalla piattaforma.
// Le regole (già nel progetto, nome libero, verifica valida) le dice il
// livello dati: qui si leggono, non si rifanno. Il fuoco va al titolo di ogni
// passo; Esc chiude (con una scelta fatta, chiede prima).

const STEPS = ["account", "repository", "branch", "access"] as const;
type Step = 1 | 2 | 3 | 4;

interface Triple {
  accountId: string;
  fullName: string;
  branch: string;
}

const lastPart = (fullName: string) => fullName.split("/").at(-1) ?? fullName;

/** Il campo di un comando: monospace alla sua misura (senza la `text-md` della prosa). */
const codeInputClass = `${inputClass.replace(" text-md ", " ")} font-code`;

export function NewRepositoryWizard({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (repositoryId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const accounts = useGitAccounts();
  const check = useCheckRepositoryAccess();
  const create = useCreateRepository();
  const simulate = useSimulateNextRepositoryCheck();
  const pendingChoice = useRef<Promise<unknown>>(Promise.resolve());
  const write = useSettingsWrite(project.code, () => undefined);

  const [step, setStep] = useState<Step>(1);
  const [furthest, setFurthest] = useState<Step>(1);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [verified, setVerified] = useState<(Triple & { outcome: TestOutcome }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [nextCheck, setNextCheck] = useState<TestOutcome>("ok");
  const [testCommand, setTestCommand] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [notVerified, setNotVerified] = useState(false);
  const [creating, setCreating] = useState(false);

  const remote = useRemoteRepositories(accountId, project.id);
  const account = accounts.data?.find((a) => a.id === accountId) ?? null;
  const chosen = remote.data?.find((r) => r.fullName === fullName) ?? null;
  const platform = account ? t(`settings.repos.platforms.${account.provider}`) : "";
  const triple: Triple | null =
    accountId && fullName && branch ? { accountId, fullName, branch } : null;
  const sameTriple =
    verified !== null &&
    triple !== null &&
    verified.accountId === triple.accountId &&
    verified.fullName === triple.fullName &&
    verified.branch === triple.branch;
  const works = sameTriple && verified?.outcome === "ok";

  const headingRef = useRef<HTMLHeadingElement>(null);
  const hintId = useId();
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    setStep(next);
    if (next > furthest) setFurthest(next);
  };

  const ready: Record<Step, boolean> = {
    1: accountId !== null,
    2: fullName !== null && name.trim() !== "",
    3: branch !== null,
    4: works,
  };
  const blockedHint: Record<Step, string> = {
    1: t("settings.repos.wizard.needAccount"),
    2: t("settings.repos.wizard.needRepository"),
    3: "",
    4: t("settings.repos.wizard.needAccess"),
  };

  function chooseAccount(id: string) {
    if (id === accountId) return;
    setAccountId(id);
    setFullName(null);
    setBranch(null);
    setName("");
    setFind("");
  }

  function chooseRepository(full: string, defaultBranch: string) {
    setFullName(full);
    setBranch(defaultBranch);
    setName(lastPart(full));
    setNameError(null);
  }

  async function verify() {
    if (!triple || checking) return;
    setChecking(true);
    setNotVerified(false);
    const asked = triple;
    await write.run(
      async () => {
        // L'esito scelto nel riquadro arriva al livello dati prima della verifica.
        await pendingChoice.current;
        const [result] = await Promise.all([
          check.mutateAsync({
            projectId: project.id,
            gitAccountId: asked.accountId,
            fullName: asked.fullName,
            branch: asked.branch,
          }),
          wait(CHECK_MS),
        ]);
        if (result.ok) setVerified({ ...asked, outcome: result.outcome });
        return result;
      },
      () => undefined,
    );
    setChecking(false);
    // L'esito scelto vale una volta (il livello dati lo azzera): il riquadro torna a «Works».
    setNextCheck("ok");
  }

  async function submit() {
    if (!triple || !works || creating) return;
    setCreating(true);
    let repositoryId: string | null = null;
    const ok = await write.run(
      async () => {
        const result = await create.mutateAsync({
          projectId: project.id,
          gitAccountId: triple.accountId,
          fullName: triple.fullName,
          name,
          branch: triple.branch,
          installCommand: installCommand.trim() || null,
          testCommand: testCommand.trim() || null,
        });
        if (result.ok) repositoryId = result.repositoryId;
        return result;
      },
      (reason) => {
        if (reason === "name" || reason === "name_taken") {
          setNameError(reason);
          setStep(2);
        } else if (reason === "access_not_verified") {
          setVerified(null);
          setNotVerified(true);
        } else if (reason === "git_account") setStep(1);
        else if (reason === "repository") setStep(2);
        else if (reason === "branch") setStep(3);
      },
    );
    setCreating(false);
    if (ok && repositoryId) onCreated(repositoryId, name.trim());
  }

  const values: Record<Step, string | null> = {
    1: account?.name ?? null,
    2: fullName,
    3: branch,
    4: works ? t("settings.repos.wizard.outcomes.ok") : null,
  };

  const footer = (
    <>
      {!ready[step] && blockedHint[step] && (
        <p id={hintId} className="mr-auto min-w-0 text-sm text-ink-muted">
          {blockedHint[step]}
        </p>
      )}
      {step > 1 && (
        <button type="button" className={secondaryButton} onClick={() => go((step - 1) as Step)}>
          {t("settings.repos.wizard.back")}
        </button>
      )}
      {step < 4 ? (
        <button
          type="button"
          aria-disabled={!ready[step] || undefined}
          aria-describedby={ready[step] ? undefined : hintId}
          className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          onClick={() => {
            if (ready[step]) go((step + 1) as Step);
          }}
        >
          {t("settings.repos.wizard.next")}
        </button>
      ) : (
        <button
          type="button"
          aria-disabled={!works || creating || undefined}
          aria-describedby={works ? undefined : hintId}
          className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          onClick={() => void submit()}
        >
          {t("settings.repos.wizard.create")}
        </button>
      )}
    </>
  );

  return (
    <Dialog
      title={t("settings.repos.wizard.title", { code: project.code })}
      width={720}
      className="max-[1279px]:w-[656px]!"
      onClose={onClose}
      confirmDiscard={
        accountId
          ? {
              message: t("settings.repos.wizard.discard"),
              keep: t("settings.repos.wizard.keep"),
              discard: t("settings.repos.wizard.discardButton"),
            }
          : undefined
      }
      footer={footer}
    >
      <div className="@container">
        <div className="flex flex-col gap-5 @min-[660px]:grid @min-[660px]:grid-cols-[180px_minmax(0,1fr)] @min-[660px]:gap-6">
          <StepList
            step={step}
            furthest={furthest}
            values={values}
            done={(i) => i < furthest && i !== step && values[i] !== null}
            onOpen={setStep}
          />
          <div className="flex min-w-0 flex-col gap-4">
            <h3
              ref={headingRef}
              tabIndex={-1}
              data-autofocus
              className="text-md font-semibold text-ink outline-none"
            >
              {t(`settings.repos.wizard.steps.${STEPS[step - 1]}`)}
            </h3>
            {step === 1 && (
              <AccountStep accounts={accounts} chosen={accountId} onChoose={chooseAccount} />
            )}
            {step === 2 && account && (
              <RepositoryStep
                project={project}
                account={account}
                remote={remote}
                find={find}
                onFind={setFind}
                chosen={fullName}
                onChoose={chooseRepository}
                name={name}
                nameError={nameError}
                onName={(v) => {
                  setName(v);
                  setNameError(null);
                }}
              />
            )}
            {step === 3 && chosen && (
              <DialogField
                label={t("settings.repos.wizard.steps.branch")}
                htmlFor={`${hintId}-branch`}
              >
                <select
                  id={`${hintId}-branch`}
                  value={branch ?? chosen.defaultBranch}
                  onChange={(e) => setBranch(e.target.value)}
                  className={`${selectClass} h-8 w-64 max-w-full font-code`}
                >
                  {chosen.branches.map((b) => (
                    <option key={b} value={b}>
                      {b === chosen.defaultBranch
                        ? t("settings.repos.wizard.branchOption", { branch: b })
                        : b}
                    </option>
                  ))}
                </select>
                <span className="max-w-[56ch] text-sm text-pretty text-ink-muted">
                  {t("settings.repos.wizard.branchBody")}
                </span>
              </DialogField>
            )}
            {step === 4 && account && triple && (
              <AccessStep
                account={account}
                platform={platform}
                triple={triple}
                checking={checking}
                result={sameTriple ? (verified?.outcome ?? null) : null}
                stale={verified !== null && !sameTriple}
                notVerified={notVerified}
                onVerify={() => void verify()}
                nextCheck={nextCheck}
                onNextCheck={(o) => {
                  setNextCheck(o);
                  pendingChoice.current = simulate.mutateAsync(o).catch(() => undefined);
                }}
                commands={
                  <>
                    <CommandField
                      label={t("settings.repos.fields.testCommand")}
                      value={testCommand}
                      onChange={setTestCommand}
                    />
                    <CommandField
                      label={t("settings.repos.fields.installCommand")}
                      value={installCommand}
                      onChange={setInstallCommand}
                    />
                  </>
                }
              />
            )}
            {write.message}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** I passi numerati: a sinistra in colonna, in riga sopra quando il dialogo è stretto. */
function StepList({
  step,
  furthest,
  values,
  done,
  onOpen,
}: {
  step: Step;
  furthest: Step;
  values: Record<Step, string | null>;
  done: (i: Step) => boolean;
  onOpen: (i: Step) => void;
}) {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={t("settings.repos.wizard.stepsLabel")}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule pb-3 @min-[660px]:flex-col @min-[660px]:flex-nowrap @min-[660px]:items-stretch @min-[660px]:gap-1 @min-[660px]:border-r @min-[660px]:border-b-0 @min-[660px]:pr-4 @min-[660px]:pb-0"
    >
      {STEPS.map((id, index) => {
        const i = (index + 1) as Step;
        const label = t(`settings.repos.wizard.steps.${id}`);
        const current = i === step;
        const isDone = done(i);
        const content = (
          <>
            <span className="flex items-center gap-1.5">
              <span className="num w-3 shrink-0 text-right">{i}</span>{" "}
              <span className={current ? "" : "@max-[479px]:sr-only"}>{label}</span>
              {isDone && (
                <span className="text-ink-muted">
                  <CheckGlyph size={12} />
                  <span className="sr-only">{t("settings.repos.wizard.done")}</span>
                </span>
              )}
            </span>
            {isDone && values[i] && (
              <span
                title={values[i]!}
                className="hidden truncate pl-[18px] text-xs font-normal text-ink-muted @min-[660px]:block"
              >
                {values[i]}
              </span>
            )}
          </>
        );
        const tone = current
          ? "font-semibold text-ink"
          : isDone
            ? "text-ink-muted hover:text-ink"
            : "text-ink-faint";
        const base = `relative flex min-w-0 flex-col py-1 text-left text-sm @min-[660px]:pl-3 ${tone} ${
          current
            ? "underline decoration-2 underline-offset-[6px] @min-[660px]:no-underline @min-[660px]:before:absolute @min-[660px]:before:inset-y-1 @min-[660px]:before:left-0 @min-[660px]:before:w-[2px] @min-[660px]:before:rounded-full @min-[660px]:before:bg-ink"
            : ""
        }`;
        return (
          <li key={id} title={label} className="min-w-0">
            {!current && (isDone || i <= furthest) ? (
              <button
                type="button"
                className={`${base} w-full rounded-sm`}
                onClick={() => onOpen(i)}
              >
                {content}
              </button>
            ) : (
              <div className={base} aria-current={current ? "step" : undefined}>
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function AccountStep({
  accounts,
  chosen,
  onChoose,
}: {
  accounts: ReturnType<typeof useGitAccounts>;
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation();
  const seesGitAccounts = useSeesGitAccounts();
  const name = useId();
  if (accounts.isPending) return <AiSkeleton rows={2} height={44} />;
  if (accounts.isError)
    return (
      <ErrorLine
        action={
          <button type="button" className={secondaryButton} onClick={() => void accounts.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        }
      >
        {t("settings.repos.wizard.accountsError")}
      </ErrorLine>
    );
  if (accounts.data.length === 0)
    return (
      <p className="max-w-[60ch] text-sm text-pretty text-ink-muted">
        {t("settings.repos.wizard.noAccounts")}{" "}
        {seesGitAccounts ? (
          <Link
            to="/admin/$section"
            params={{ section: "git-accounts" }}
            className="text-ink underline underline-offset-4"
          >
            {t("settings.repos.wizard.openGitAccounts")}
          </Link>
        ) : (
          <WhoCanLink action="manageGitAccounts" projectId={null} />
        )}
      </p>
    );
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.repos.wizard.steps.account")}
      className="border-t border-rule"
    >
      {accounts.data.map((a) => (
        <label
          key={a.id}
          className="flex cursor-pointer items-start gap-3 border-b border-rule py-2.5"
        >
          <input
            type="radio"
            name={name}
            checked={chosen === a.id}
            onChange={() => onChoose(a.id)}
            className="mt-1 accent-ink"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-semibold text-ink">{a.name}</span>
              <span className="text-ink-muted">{t(`settings.repos.platforms.${a.provider}`)}</span>
              <span className="text-ink-muted">
                <CheckWords checking={false} last={a.lastValidation} />
              </span>
            </span>
            {a.lastValidation?.outcome === "invalid_credentials" && (
              <span className="text-xs text-ink-muted">
                {t("settings.repos.wizard.accountFailed")}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

function RepositoryStep({
  project,
  account,
  remote,
  find,
  onFind,
  chosen,
  onChoose,
  name,
  nameError,
  onName,
}: {
  project: Project;
  account: GitAccountView;
  remote: ReturnType<typeof useRemoteRepositories>;
  find: string;
  onFind: (v: string) => void;
  chosen: string | null;
  onChoose: (fullName: string, defaultBranch: string) => void;
  name: string;
  nameError: string | null;
  onName: (v: string) => void;
}) {
  const { t } = useTranslation();
  const radio = useId();
  const nameId = useId();
  const needle = find.trim().toLowerCase();
  const shown = (remote.data ?? []).filter((r) => r.fullName.toLowerCase().includes(needle));
  return (
    <>
      <input
        type="search"
        value={find}
        aria-label={t("settings.repos.wizard.find")}
        placeholder={t("settings.repos.wizard.find")}
        onChange={(e) => onFind(e.target.value)}
        className={`${inputClass} h-8`}
      />
      {remote.isPending ? (
        <AiSkeleton rows={5} height={40} />
      ) : remote.isError ? (
        <ErrorLine
          action={
            <button type="button" className={secondaryButton} onClick={() => void remote.refetch()}>
              {t("taskUi.states.retry")}
            </button>
          }
        >
          {t("settings.repos.wizard.remoteError", { account: account.name })}
        </ErrorLine>
      ) : shown.length === 0 ? (
        <p className="max-w-[60ch] text-sm text-pretty text-ink-muted">
          {t("settings.repos.wizard.noMatch", { account: account.name })}
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t("settings.repos.wizard.steps.repository")}
          className="max-h-[320px] overflow-y-auto border-y border-rule"
        >
          {shown.map((r) => (
            <label
              key={r.fullName}
              className={`flex min-h-10 items-center gap-3 border-b border-rule px-1 last:border-b-0 ${
                r.inProject ? "cursor-not-allowed text-ink-faint" : "cursor-pointer text-ink"
              }`}
            >
              <input
                type="radio"
                name={radio}
                checked={chosen === r.fullName}
                disabled={r.inProject}
                onChange={() => onChoose(r.fullName, r.defaultBranch)}
                className="accent-ink"
              />
              <span title={r.fullName} className="min-w-0 flex-1 truncate text-sm">
                {r.fullName}
              </span>
              <span className={`shrink-0 text-xs ${r.inProject ? "" : "text-ink-muted"}`}>
                {r.inProject
                  ? t("settings.repos.wizard.alreadyIn", { code: project.code })
                  : t("settings.repos.wizard.defaultBranch", { branch: r.defaultBranch })}
              </span>
            </label>
          ))}
        </div>
      )}
      {chosen && (
        <DialogField label={t("settings.repos.wizard.name")} htmlFor={nameId}>
          <input
            id={nameId}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={`${nameId}-hint${nameError ? ` ${nameId}-error` : ""}`}
            onChange={(e) => onName(e.target.value)}
            className={`${inputClass} h-8 aria-invalid:border-critical`}
          />
          <span id={`${nameId}-hint`} className="text-xs text-ink-muted">
            {t("settings.repos.nameHint", {
              code: project.code,
              name: name.trim() || lastPart(chosen),
            })}
          </span>
          {nameError && (
            <ErrorLine id={`${nameId}-error`}>
              {nameError === "name_taken"
                ? t("settings.repos.nameTaken", { code: project.code, name: name.trim() })
                : t("settings.repos.nameInvalid")}
            </ErrorLine>
          )}
        </DialogField>
      )}
    </>
  );
}

function AccessStep({
  account,
  platform,
  triple,
  checking,
  result,
  stale,
  notVerified,
  onVerify,
  nextCheck,
  onNextCheck,
  commands,
}: {
  account: GitAccountView;
  platform: string;
  triple: Triple;
  checking: boolean;
  result: TestOutcome | null;
  stale: boolean;
  notVerified: boolean;
  onVerify: () => void;
  nextCheck: TestOutcome;
  onNextCheck: (o: TestOutcome) => void;
  commands: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="max-w-[60ch] text-sm text-pretty text-ink-muted">
        {t("settings.repos.wizard.accessBody", {
          account: account.name,
          repository: triple.fullName,
          branch: triple.branch,
        })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-disabled={checking || undefined}
          className={`${secondaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          onClick={onVerify}
        >
          {t("settings.repos.wizard.verify")}
        </button>
        <span aria-live="polite" className="min-w-0 text-sm">
          {checking ? (
            <span className="text-ink-muted">{t("settings.repos.wizard.checking")}</span>
          ) : result === "ok" ? (
            <span className="inline-flex items-center gap-1.5 text-ink">
              <span className="text-positive">
                <CheckGlyph size={14} />
              </span>
              <span>{t("settings.repos.wizard.outcomes.ok")}</span>
            </span>
          ) : stale ? (
            <span className="text-ink-muted">{t("settings.repos.wizard.stale")}</span>
          ) : null}
        </span>
      </div>
      {!checking && result && result !== "ok" && (
        <p className="flex max-w-[60ch] items-start gap-1.5 text-sm text-pretty text-critical">
          <span className="mt-[3px] shrink-0">
            <CrossGlyph />
          </span>
          <span className="min-w-0">
            {t(`settings.repos.wizard.outcomes.${result}`, { account: account.name, platform })}
          </span>
        </p>
      )}
      {!checking && result === "ok" && (
        <div className="compose-enter flex flex-col gap-3">{commands}</div>
      )}
      {notVerified && <ErrorLine>{t("settings.repos.wizard.notVerified")}</ErrorLine>}
      <PrototypeBox>
        <p className="text-sm text-ink-muted">{t("settings.repos.wizard.prototype.intro")}</p>
        <Segmented<TestOutcome>
          label={t("settings.repos.wizard.prototype.label")}
          value={nextCheck}
          options={(["ok", "invalid_credentials", "unreachable"] as const).map((o) => ({
            value: o,
            label: t(`settings.repos.wizard.prototype.${o}`),
          }))}
          onChange={onNextCheck}
        />
      </PrototypeBox>
    </>
  );
}

function CommandField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <DialogField label={label} htmlFor={id} hint={t("settings.repos.wizard.commandHint")}>
      <input
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className={`${codeInputClass} h-8`}
      />
    </DialogField>
  );
}
