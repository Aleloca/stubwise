import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDeleteDetachedRepository,
  useLinkRepository,
  type DetachedRepositoryRow,
} from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog, DialogField } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { selectClass } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { useSettingsWrite } from "../../settings/SettingsFrame";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";

// I due dialoghi di un repository senza progetto (area 9c, Task 11, shape
// project-archive.md «Not in any project»), aperti dalla sua riga in
// Amministrazione → Repositories:
// - «Link to a project…» (440 px): i soli progetti della vista
//   (`linkTargets`), nessuna riconferma; il nome già usato nel progetto
//   scelto si dice qui e il dialogo resta aperto;
// - «Delete…» (440 px, solo il full admin): la conferma `critical` e la
//   riconferma (+R; maintainer, 31 ott 2026, domanda 4 (b)).
// Riuscito, chi ha aperto il dialogo decide dove va il fuoco (`onDone`): la
// riga sparisce dal gruppo.

export function LinkRepositoryDialog({
  repository: r,
  onClose,
  onReload,
  onDone,
}: {
  repository: DetachedRepositoryRow;
  onClose: () => void;
  onReload: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const link = useLinkRepository();
  const [projectId, setProjectId] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const selectId = useId();
  const target = r.linkTargets.find((p) => p.projectId === projectId);
  const write = useSettingsWrite(target?.code ?? "", onReload, {
    forbidden: t("admin.repositories.detached.linkDialog.forbidden", { code: target?.code ?? "" }),
    onNotFound: () => {
      toast.error(t("admin.repositories.detached.linkDialog.gone"));
      onClose();
      onReload();
    },
  });

  async function submit() {
    if (!target || sending) return;
    setSending(true);
    setRefusal(null);
    await write.run(
      () => link.mutateAsync({ repositoryId: r.id, projectId: target.projectId }),
      (reason) => {
        if (reason === "name_taken")
          setRefusal(
            t("admin.repositories.detached.linkDialog.nameTaken", {
              code: target.code,
              name: r.name,
            }),
          );
      },
      () => {
        toast.show(
          t("admin.repositories.detached.linkDialog.done", { name: r.name, code: target.code }),
          {
            action: {
              label: t("admin.repositories.detached.linkDialog.open"),
              run: () =>
                void navigate({
                  to: "/p/$code/settings/$section",
                  params: { code: target.code, section: "repositories" },
                  search: { repo: r.id } as never,
                }),
            },
          },
        );
        onClose();
        onDone();
      },
    );
    setSending(false);
  }

  return (
    <Dialog
      title={t("admin.repositories.detached.linkDialog.title", { name: r.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.repositories.detached.linkDialog.cancel")}
          </button>
          <button
            type="button"
            disabled={!target}
            aria-busy={sending || undefined}
            onClick={() => void submit()}
            className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {sending
              ? t("admin.repositories.detached.linkDialog.linking")
              : t("admin.repositories.detached.linkDialog.link")}
          </button>
        </>
      }
    >
      <DialogField label={t("admin.repositories.detached.linkDialog.project")} htmlFor={selectId}>
        <select
          id={selectId}
          data-autofocus
          value={projectId}
          aria-invalid={refusal ? true : undefined}
          onChange={(e) => {
            setProjectId(e.target.value);
            setRefusal(null);
          }}
          className={`${selectClass} h-8 w-full`}
        >
          <option value="" disabled>
            {t("admin.repositories.detached.linkDialog.choose")}
          </option>
          {r.linkTargets.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {`${p.code} · ${p.name}`}
            </option>
          ))}
        </select>
      </DialogField>
      {refusal && <ErrorLine>{refusal}</ErrorLine>}
      <ul className="flex flex-col gap-2 text-md text-pretty text-ink">
        {(["address", "webhook"] as const).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-[8px] size-1 shrink-0 rounded-full bg-ink-muted"
            />
            <span className="min-w-0">{t(`admin.repositories.detached.linkDialog.${line}`)}</span>
          </li>
        ))}
      </ul>
      {write.message}
    </Dialog>
  );
}

export function DeleteDetachedRepositoryDialog({
  repository: r,
  onClose,
  onReload,
  onDone,
}: {
  repository: DetachedRepositoryRow;
  onClose: () => void;
  onReload: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useDeleteDetachedRepository();
  const [sending, setSending] = useState(false);
  const write = useSettingsWrite(r.name, onReload, {
    forbidden: t("admin.repositories.detached.deleteDialog.forbidden"),
    onNotFound: () => {
      toast.error(t("admin.repositories.detached.deleteDialog.gone"));
      onClose();
      onReload();
    },
  });
  const platform = r.gitAccountProvider ? t(`admin.git.platform.${r.gitAccountProvider}`) : null;

  async function submit() {
    if (sending) return;
    setSending(true);
    await write.run(
      () =>
        reauth(() => remove.mutateAsync(r.id), {
          action: t("admin.repositories.detached.deleteDialog.reauthAction", { name: r.name }),
        }),
      () => undefined,
      () => {
        toast.show(t("admin.repositories.detached.deleteDialog.done", { name: r.name }));
        onClose();
        onDone();
      },
    );
    setSending(false);
  }

  return (
    <Dialog
      title={t("admin.repositories.detached.deleteDialog.title", { name: r.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
            {t("admin.repositories.detached.deleteDialog.cancel")}
          </button>
          <button
            type="button"
            aria-busy={sending || undefined}
            onClick={() => void submit()}
            className={dangerSolidButton}
          >
            {sending
              ? t("admin.repositories.detached.deleteDialog.deleting")
              : t("admin.repositories.detached.deleteDialog.submit")}
          </button>
        </>
      }
    >
      <p className="flex items-start gap-1.5 text-md font-semibold text-critical">
        <svg
          viewBox="0 0 16 16"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
          className="mt-[3px] shrink-0"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5" />
        </svg>
        <span>{t("admin.repositories.detached.deleteDialog.undone")}</span>
      </p>
      <p className="text-md text-pretty text-ink">
        {platform
          ? t("admin.repositories.detached.deleteDialog.forgets", { platform })
          : t("admin.repositories.detached.deleteDialog.forgetsNoPlatform")}
      </p>
      {r.gitAccountName && (
        <p className="text-md text-pretty text-ink">
          {t("admin.repositories.detached.deleteDialog.account", { account: r.gitAccountName })}
        </p>
      )}
      {write.message}
    </Dialog>
  );
}
