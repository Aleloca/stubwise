import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { maskedSecret } from "../../../components/SecretField";
import {
  useGitAccounts,
  useSetDefaultReviewer,
  useSimulateNextTest,
  useValidateGitAccount,
  type GitAccountView,
  type TestOutcome,
} from "../../../data/queries";
import { can, useViewer } from "../../../data/viewer";
import { itemClass } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { Segmented, selectClass } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { CheckGlyph } from "../../preferences/glyphs";
import { ReadError, RowMenu, refusalOf } from "../../preferences/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { AiSkeleton } from "../ai/parts";
import {
  CreateGitAccountDialog,
  DefaultReviewerDialog,
  DeleteGitAccountDialog,
  EditGitAccountDialog,
  ReplaceGitTokenDialog,
} from "./GitAccountDialog";
import {
  CHECK_MS,
  CheckWords,
  Dot,
  IntegrationPage,
  ReadOnlyNote,
  useRefusalWords,
  wait,
} from "./parts";

// Git accounts (shape admin-integrations.md «Git accounts»): le credenziali
// con cui Stubwise legge e scrive i repository, una riga per account con la
// coda del token, l'ultima verifica e chi lo usa. Si legge con
// `git_accounts.view` o `.manage`, si scrive con `.manage`: senza, la riga di
// sola lettura in testa e i bottoni spenti, ognuno col suo «Who?». La
// verifica è l'unico bottone sulla riga [IN 1], il resto sta nel «⋯».
// Chi usa un account lo dice il livello dati: i repository dei progetti che
// chi guarda vede per nome (codice del progetto), gli altri solo contati
// (R-G5).

const WHO = "manageGitAccounts";
/** Quanto resta evidenziata la riga appena creata. */
const ADDED_MS = 2000;

type Dialog =
  | { kind: "create" }
  | { kind: "edit" | "replace" | "reviewer" | "delete"; account: GitAccountView };

export function GitAccountsPage() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const canWrite = can(viewer, "git_accounts.manage");
  const accounts = useGitAccounts();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(null), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [added]);

  const action = (
    <>
      {!canWrite && <WhoCanLink action={WHO} projectId={null} />}
      <button
        type="button"
        disabled={!canWrite}
        title={canWrite ? undefined : t("admin.git.readOnly")}
        onClick={() => setDialog({ kind: "create" })}
        className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        {t("admin.git.new")}
      </button>
    </>
  );

  return (
    <IntegrationPage title={t("admin.git.title")} intro={t("admin.git.intro")} action={action}>
      {!canWrite && <ReadOnlyNote text={t("admin.git.readOnly")} action={WHO} />}
      {accounts.isPending ? (
        <AiSkeleton rows={2} height={60} />
      ) : accounts.isError ? (
        <ReadError message={t("admin.git.loadError")} onRetry={() => void accounts.refetch()} />
      ) : accounts.data.length === 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="text-md text-ink">{t("admin.git.empty")}</p>
          {!canWrite && (
            <p className="mt-1 text-sm text-ink-muted">
              {t("admin.git.emptyReadOnly")} <WhoCanLink action={WHO} projectId={null} />
            </p>
          )}
        </div>
      ) : (
        <>
          <ul aria-label={t("admin.git.list")} className="@container mt-6 border-t border-rule">
            {accounts.data.map((a) => (
              <GitAccountRow
                key={a.id}
                account={a}
                canWrite={canWrite}
                justAdded={added === a.id}
                onOpen={(kind) => setDialog({ kind, account: a })}
              />
            ))}
          </ul>
          {canWrite && <NextCheckBox accounts={accounts.data} />}
        </>
      )}
      {dialog?.kind === "create" && (
        <CreateGitAccountDialog onClose={() => setDialog(null)} onCreated={setAdded} />
      )}
      {dialog?.kind === "edit" && (
        <EditGitAccountDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "replace" && (
        <ReplaceGitTokenDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "reviewer" && (
        <DefaultReviewerDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteGitAccountDialog account={dialog.account} onClose={() => setDialog(null)} />
      )}
    </IntegrationPage>
  );
}

/** «Bitbucket · audin» o «GitHub»: la piattaforma in parola, col workspace. */
export function usePlatformWords() {
  const { t } = useTranslation();
  return (a: Pick<GitAccountView, "provider" | "workspace">) => {
    const platform = t(`admin.git.platform.${a.provider}`);
    return a.workspace ? `${platform} · ${a.workspace}` : platform;
  };
}

/**
 * Un account (60 px, due righe). Prima: nome · piattaforma · «Default
 * reviewer», a destra Validate e «⋯». Seconda: la coda del token, l'ultima
 * verifica, chi lo usa; stretta (1024) va a capo sotto, Validate resta sulla
 * prima.
 */
function GitAccountRow({
  account: a,
  canWrite,
  justAdded,
  onOpen,
}: {
  account: GitAccountView;
  canWrite: boolean;
  justAdded: boolean;
  onOpen: (kind: "edit" | "replace" | "reviewer" | "delete") => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const validate = useValidateGitAccount();
  const setReviewer = useSetDefaultReviewer();
  const refusalWords = useRefusalWords();
  const platformWords = usePlatformWords();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const ref = useRef<HTMLLIElement>(null);

  // Dopo la creazione il fuoco va alla riga nuova (shape §6).
  useEffect(() => {
    if (justAdded) ref.current?.focus();
  }, [justAdded]);

  async function runCheck() {
    setError(null);
    setChecking(true);
    const [result] = await Promise.all([validate.mutateAsync(a.id).catch(() => null), wait(CHECK_MS)]);
    setChecking(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) setError(refusalWords(refusal.error) || null);
  }

  async function stopReviewer() {
    setError(null);
    const result = await setReviewer.mutateAsync([a.id, false]).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.git.stopped", { name: a.name }));
  }

  return (
    <li
      ref={ref}
      tabIndex={-1}
      aria-labelledby={nameId}
      className={`border-b border-rule outline-none transition-colors duration-[var(--duration-base)] ease-out focus-visible:bg-ink/4 ${justAdded ? "bg-ink/6" : ""}`}
    >
      <div className="flex min-h-[60px] flex-col justify-center gap-1 py-2 pr-1 pl-1">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span id={nameId} title={a.name} className="min-w-0 truncate text-md font-semibold text-ink">
              {a.name}
            </span>
            <span className="shrink-0 text-sm text-ink-muted">{platformWords(a)}</span>
            {a.defaultReviewer && (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-ink">
                <CheckGlyph size={12} />
                <span>{t("admin.git.defaultReviewer")}</span>
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {/* Spento per permesso: «Who?» accanto (GC del maintainer). */}
            {!canWrite && <WhoCanLink action={WHO} projectId={null} />}
            <button
              type="button"
              disabled={!canWrite || checking}
              title={canWrite ? undefined : t("admin.git.readOnly")}
              aria-describedby={nameId}
              onClick={() => void runCheck()}
              className={`${secondaryButton} h-7 px-2.5 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t("admin.git.validate")}
            </button>
            {canWrite && (
              <RowMenu label={t("admin.git.menu", { name: a.name })}>
                {(close) => (
                  <>
                    <MenuItem onSelect={() => (close(false), onOpen("edit"))}>
                      {t("admin.git.edit")}
                    </MenuItem>
                    <MenuItem onSelect={() => (close(false), onOpen("replace"))}>
                      {t("admin.git.replaceToken")}
                    </MenuItem>
                    {a.defaultReviewer ? (
                      <MenuItem onSelect={() => (close(true), void stopReviewer())}>
                        {t("admin.git.stopDefault")}
                      </MenuItem>
                    ) : (
                      <MenuItem onSelect={() => (close(false), onOpen("reviewer"))}>
                        {t("admin.git.makeDefault")}
                      </MenuItem>
                    )}
                    <MenuItem onSelect={() => (close(false), onOpen("delete"))}>
                      {t("admin.git.delete")}
                    </MenuItem>
                  </>
                )}
              </RowMenu>
            )}
          </span>
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-ink-muted">
          <span className="num font-mono">{maskedSecret(a.last4)}</span>
          <Dot />
          <CheckWords checking={checking} last={a.lastValidation} />
          <Dot />
          <UsageWords account={a} />
        </p>
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
    </li>
  );
}

/**
 * Chi usa l'account, dal livello dati: «Used by 6 repositories in ACQ, AUD,
 * STW» (codici dei progetti visibili, una volta ciascuno) e «and 2 in
 * projects you can't see»; nessuno → «Not used yet».
 */
function UsageWords({ account: a }: { account: GitAccountView }) {
  const { t } = useTranslation();
  const hidden = a.hiddenRepositories;
  const shown = a.repositories.length;
  if (shown === 0 && hidden === 0) return <span>{t("admin.git.notUsed")}</span>;
  if (shown === 0) return <span>{t("admin.git.onlyHidden", { count: hidden })}</span>;
  const codes = [...new Set(a.repositories.map((r) => r.projectCode))].join(", ");
  return (
    <>
      <span>{t("admin.git.usedBy", { count: shown, codes })}</span>
      {hidden > 0 && <span>{t("admin.git.andHidden", { count: hidden })}</span>}
    </>
  );
}

function MenuItem({ children, onSelect }: { children: string; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} className={itemClass}>
      {children}
    </button>
  );
}

/**
 * Il riquadro «Prototype only»: nessun sistema vero si contatta, e chi prova
 * sceglie cosa risponde la prossima verifica di un account. Nessuna voce del
 * registro.
 */
function NextCheckBox({ accounts }: { accounts: GitAccountView[] }) {
  const { t } = useTranslation();
  const simulate = useSimulateNextTest();
  const selectId = useId();
  const [target, setTarget] = useState(accounts[0]!.id);
  const [outcome, setOutcome] = useState<TestOutcome>("ok");
  const current = accounts.some((a) => a.id === target) ? target : accounts[0]!.id;
  const choose = (id: string, next: TestOutcome) => {
    setTarget(id);
    setOutcome(next);
    simulate.mutate([id, next]);
  };
  return (
    <div className="mt-8">
      <PrototypeBox label={t("admin.integrations.prototype.label")}>
        <p className="text-sm text-ink-muted">{t("admin.integrations.prototype.checkIntro")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={selectId} className="text-sm text-ink">
            {t("admin.integrations.prototype.account")}
          </label>
          <select
            id={selectId}
            value={current}
            onChange={(e) => choose(e.target.value, outcome)}
            className={`${selectClass} w-48`}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Segmented<TestOutcome>
            label={t("admin.integrations.prototype.outcome")}
            value={outcome}
            options={(["ok", "invalid_credentials", "unreachable"] as const).map((o) => ({
              value: o,
              label: t(`admin.integrations.prototype.${o}`),
            }))}
            onChange={(o) => choose(current, o)}
          />
        </div>
      </PrototypeBox>
    </div>
  );
}
