import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SecretInput } from "../../../components/SecretField";
import {
  useCreateGitAccount,
  useDeleteGitAccount,
  useReplaceGitToken,
  useSetDefaultReviewer,
  useUpdateGitAccount,
  type GitAccountView,
} from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { Segmented } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { refusalOf } from "../../preferences/parts";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { TextField, useRefusalWords } from "./parts";

// I dialoghi di Git accounts (shape admin-integrations.md): nuovo account,
// modifica, sostituzione del token, revisore predefinito, eliminazione.
// Creare, sostituire il token ed eliminare chiedono la riconferma (`useReauth`);
// il token vive solo nello stato del dialogo (`SecretInput`) e poi resta
// solo «•••• 9f2c». Gli errori stanno sotto il campo; la riconferma chiusa
// lascia il dialogo aperto coi valori (il suo dialogo dice già «Nothing was
// changed.»).

type Provider = GitAccountView["provider"];

/** Il footer comune: Annulla e il bottone dell'azione. */
function Footer({
  onCancel,
  submit,
  onSubmit,
  busy,
  danger = false,
}: {
  onCancel: () => void;
  submit: string;
  onSubmit: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className={secondaryButton} onClick={onCancel}>
        {t("admin.integrations.cancel")}
      </button>
      <button
        type="button"
        disabled={busy}
        className={`${danger ? dangerSolidButton : primaryButton} disabled:opacity-40`}
        onClick={onSubmit}
      >
        {submit}
      </button>
    </>
  );
}

/** «New account» (480 px): piattaforma, nome, workspace (solo Bitbucket), token. */
export function CreateGitAccountDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** L'account creato: la pagina lo evidenzia e gli dà il fuoco. */
  onCreated: (accountId: string) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateGitAccount();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [provider, setProvider] = useState<Provider>("bitbucket");
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<{
    name?: string;
    workspace?: string;
    token?: string;
    form?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const words = (key: string, params?: Record<string, string>) =>
    t(`admin.git.createDialog.errors.${key}`, params);

  async function submit() {
    const trimmed = name.trim();
    const missing = {
      ...(trimmed ? {} : { name: words("name") }),
      ...(provider === "bitbucket" && !workspace.trim() ? { workspace: words("workspace") } : {}),
      ...(token.trim() ? {} : { token: words("token") }),
    };
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    const result = await reauth(
      () =>
        create.mutateAsync({
          name: trimmed,
          provider,
          workspace: provider === "bitbucket" ? workspace : null,
          token,
        }),
      { action: t("admin.git.createDialog.action", { name: trimmed }) },
    ).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "conflict") return setErrors({ name: words("taken", { name: trimmed }) });
      if (refusal.error === "invalid" && refusal.reason && ["name", "workspace", "token"].includes(refusal.reason))
        return setErrors({ [refusal.reason]: words(refusal.reason) });
      const form = refusalWords(refusal.error);
      return setErrors(form ? { form } : {});
    }
    toast.show(t("admin.git.createDialog.created", { name: trimmed }));
    onCreated((result as { accountId: string }).accountId);
    onClose();
  }

  return (
    <Dialog
      title={t("admin.git.createDialog.title")}
      onClose={onClose}
      width={480}
      footer={
        <Footer
          onCancel={onClose}
          submit={t("admin.git.createDialog.submit")}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <div className="flex flex-col gap-1.5">
        <span aria-hidden="true" className="text-sm font-medium text-ink">
          {t("admin.git.createDialog.platform")}
        </span>
        <Segmented<Provider>
          label={t("admin.git.createDialog.platform")}
          value={provider}
          options={(["bitbucket", "github"] as const).map((p) => ({
            value: p,
            label: t(`admin.git.platform.${p}`),
          }))}
          onChange={setProvider}
        />
      </div>
      <TextField
        label={t("admin.git.createDialog.name")}
        value={name}
        onChange={setName}
        placeholder={t("admin.git.createDialog.namePlaceholder")}
        error={errors.name}
        autoFocus
      />
      {provider === "bitbucket" && (
        <TextField
          label={t("admin.git.createDialog.workspace")}
          value={workspace}
          onChange={setWorkspace}
          hint={t("admin.git.createDialog.workspaceHint")}
          error={errors.workspace}
          mono
        />
      )}
      <SecretInput
        label={t("admin.git.createDialog.token")}
        value={token}
        onChange={setToken}
        error={errors.token}
      />
      <p className="text-xs text-ink-muted">{t("admin.git.createDialog.bottom")}</p>
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** «Edit…» (440 px): nome e workspace, nessuna riconferma. */
export function EditGitAccountDialog({
  account: a,
  onClose,
}: {
  account: GitAccountView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateGitAccount();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [name, setName] = useState(a.name);
  const [workspace, setWorkspace] = useState(a.workspace ?? "");
  const [errors, setErrors] = useState<{ name?: string; workspace?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const bitbucket = a.provider === "bitbucket";
  const words = (key: string, params?: Record<string, string>) =>
    t(`admin.git.createDialog.errors.${key}`, params);

  async function submit() {
    setBusy(true);
    const result = await update
      .mutateAsync([a.id, { name, ...(bitbucket ? { workspace } : {}) }])
      .catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "conflict")
        return setErrors({ name: words("taken", { name: name.trim() }) });
      if (refusal.error === "invalid" && (refusal.reason === "name" || refusal.reason === "workspace"))
        return setErrors({ [refusal.reason]: words(refusal.reason) });
      const form = refusalWords(refusal.error);
      return setErrors(form ? { form } : {});
    }
    toast.show(t("admin.integrations.saved"));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.git.editDialog.title", { name: a.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          onCancel={onClose}
          submit={t("admin.git.editDialog.submit")}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <TextField
        label={t("admin.git.createDialog.name")}
        value={name}
        onChange={setName}
        error={errors.name}
        autoFocus
      />
      {bitbucket && (
        <TextField
          label={t("admin.git.createDialog.workspace")}
          value={workspace}
          onChange={setWorkspace}
          hint={
            a.defaultReviewer
              ? `${t("admin.git.createDialog.workspaceHint")} ${t("admin.git.editDialog.reviewerNote")}`
              : t("admin.git.createDialog.workspaceHint")
          }
          error={errors.workspace}
          mono
        />
      )}
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** «Replace token…» (440 px, +R): l'account torna «not checked yet». */
export function ReplaceGitTokenDialog({
  account: a,
  onClose,
}: {
  account: GitAccountView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const replace = useReplaceGitToken();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value.trim()) return setError(t("admin.git.createDialog.errors.token"));
    setBusy(true);
    const result = await reauth(() => replace.mutateAsync([a.id, value]), {
      action: t("admin.git.replaceDialog.action", { name: a.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.git.replaceDialog.done", { name: a.name }));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.git.replaceDialog.title", { name: a.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          onCancel={onClose}
          submit={t("admin.git.replaceDialog.submit")}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <SecretInput
        label={t("admin.git.createDialog.token")}
        value={value}
        onChange={setValue}
        error={error}
        autoFocus
      />
      <p className="text-sm text-ink-muted">{t("admin.git.replaceDialog.running")}</p>
    </Dialog>
  );
}

/**
 * «Make default reviewer» (440 px, nessuna riconferma): cosa fa il revisore
 * e, se c'è, chi sostituisce nello stesso ambito (lo dice il livello dati,
 * `replacesAsReviewer`). Il toast dice chi ha sostituito davvero.
 */
export function DefaultReviewerDialog({
  account: a,
  onClose,
}: {
  account: GitAccountView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setReviewer = useSetDefaultReviewer();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = t(`admin.git.platform.${a.provider}`);
  const where = a.workspace
    ? t("admin.git.reviewerDialog.platformWorkspace", { platform, workspace: a.workspace })
    : platform;

  async function submit() {
    setBusy(true);
    const result = await setReviewer.mutateAsync([a.id, true]).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    const { replaced } = result as { replaced: string | null };
    toast.show(
      replaced
        ? t("admin.git.reviewerDialog.done", { name: replaced })
        : t("admin.git.reviewerDialog.doneAlone", { name: a.name }),
    );
    onClose();
  }

  return (
    <Dialog
      title={t("admin.git.reviewerDialog.title", { name: a.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          onCancel={onClose}
          submit={t("admin.git.reviewerDialog.submit")}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <p className="text-md text-pretty text-ink">
        {t("admin.git.reviewerDialog.body", { name: a.name, platform: where })}
      </p>
      {a.replacesAsReviewer && (
        <p className="text-md text-pretty text-ink">
          {t("admin.git.reviewerDialog.replaces", { name: a.replacesAsReviewer })}
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

type InUse = { repositories: { name: string; projectCode: string | null }[]; hidden: number };

/**
 * «Delete…»: in uso (dalla lettura, o dal rifiuto `in_use` se nel frattempo
 * un repository l'ha preso) il dialogo elenca i repository che chi guarda
 * vede, conta gli altri e si chiude e basta; libero, la conferma e la
 * riconferma.
 */
export function DeleteGitAccountDialog({
  account: a,
  onClose,
}: {
  account: GitAccountView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteGitAccount();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [inUse, setInUse] = useState<InUse | null>(
    a.repositories.length + a.hiddenRepositories > 0
      ? { repositories: a.repositories, hidden: a.hiddenRepositories }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await reauth(() => remove.mutateAsync(a.id), {
      action: t("admin.git.deleteDialog.action", { name: a.name }),
    }).catch(() => null);
    setBusy(false);
    if (result !== null && !result.ok && result.error === "in_use")
      return setInUse({
        repositories: result.usedBy.map((u) => ({ name: u.label, projectCode: u.projectCode })),
        hidden: result.hiddenCount,
      });
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.git.deleteDialog.done", { name: a.name }));
    onClose();
  }

  if (inUse)
    return (
      <Dialog
        title={t("admin.git.deleteDialog.inUseTitle", { name: a.name })}
        onClose={onClose}
        width={480}
        footer={
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.integrations.close")}
          </button>
        }
      >
        {inUse.repositories.length > 0 ? (
          <>
            <ul
              aria-label={t("admin.git.deleteDialog.repositories", { name: a.name })}
              className="flex max-h-60 flex-col overflow-y-auto border-y border-rule"
            >
              {inUse.repositories.map((r) => (
                <li key={`${r.projectCode}/${r.name}`} className="border-b border-rule last:border-b-0">
                  {r.projectCode ? (
                    <Link
                      to="/p/$code/settings/$section"
                      params={{ code: r.projectCode, section: "repositories" }}
                      className="flex h-9 items-center gap-2 rounded-sm px-1 text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
                    >
                      <span className="min-w-0 truncate">{r.name}</span>
                      <span aria-hidden="true" className="text-ink-faint">
                        ·
                      </span>
                      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
                        {r.projectCode}
                      </span>
                    </Link>
                  ) : (
                    <span className="flex h-9 items-center px-1 text-md text-ink">{r.name}</span>
                  )}
                </li>
              ))}
            </ul>
            {inUse.hidden > 0 && (
              <p className="text-sm text-ink-muted">
                {t("admin.git.andHidden", { count: inUse.hidden })}
              </p>
            )}
          </>
        ) : (
          <p className="text-md text-ink">
            {t("admin.git.deleteDialog.onlyHidden", { count: inUse.hidden })}
          </p>
        )}
        <p className="text-md text-pretty text-ink">{t("admin.git.deleteDialog.inUseBody")}</p>
      </Dialog>
    );

  return (
    <Dialog
      title={t("admin.git.deleteDialog.title", { name: a.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          onCancel={onClose}
          submit={t("admin.git.deleteDialog.submit")}
          onSubmit={() => void submit()}
          busy={busy}
          danger
        />
      }
    >
      <p className="text-md text-pretty text-ink">{t("admin.git.deleteDialog.body")}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
