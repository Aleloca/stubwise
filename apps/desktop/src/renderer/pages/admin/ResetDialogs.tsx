import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreatePasswordResetLink,
  useResetSecondFactor,
  type PersonDetail,
} from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { ErrorLine } from "../entry/parts";
import { SecretOnce } from "../preferences/SecretOnce";
import { refusalOf } from "../preferences/parts";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { useRefusalWords, useShortDate, type UiRefusal } from "./parts";

// I due reset della pagina di una persona (shape admin-people.md, «Reset
// password e secondo fattore»): dialoghi da 440 px, conseguenze dette prima,
// poi la riconferma. Il link di reset si vede una volta, qui, con
// `SecretOnce`: «Done» lo dimentica.

/** «10:12», nell'orologio del prototipo (UTC, come le date). */
function timeOf(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function ResetPasswordDialog({
  person,
  onClose,
}: {
  person: PersonDetail;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const create = useCreatePasswordResetLink();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const date = useShortDate();
  const [secret, setSecret] = useState<{ link: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = person.name;

  async function submit() {
    setError(null);
    const result = await reauth(() => create.mutateAsync([person.personId]), {
      action: t("admin.resetPassword.reauthAction", { name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name }));
    setSecret(result as { link: string; expiresAt: string });
  }

  return (
    <Dialog
      title={t("admin.resetPassword.title", { name })}
      description={secret ? undefined : t("admin.resetPassword.body", { name })}
      onClose={onClose}
      width={440}
      footer={
        secret ? undefined : (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("admin.invite.cancel")}
            </button>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={create.isPending}
              onClick={() => void submit()}
            >
              {create.isPending ? t("admin.resetPassword.creating") : t("admin.resetPassword.create")}
            </button>
          </>
        )
      }
    >
      {secret ? (
        <SecretOnce
          title={t("admin.resetPassword.secretTitle", { name })}
          value={secret.link}
          onDone={onClose}
        >
          <p>
            {t("admin.resetPassword.meta", {
              name,
              date: date(secret.expiresAt),
              time: timeOf(secret.expiresAt, i18n.language),
            })}
          </p>
        </SecretOnce>
      ) : (
        error && <ErrorLine>{error}</ErrorLine>
      )}
    </Dialog>
  );
}

export function ResetSecondFactorDialog({
  person,
  peer,
  onClose,
}: {
  person: PersonDetail;
  /** Un full admin su un altro: la riga in più sul registro e sull'avviso. */
  peer: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reset = useResetSecondFactor();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const name = person.name;

  async function submit() {
    setError(null);
    const result = await reauth(() => reset.mutateAsync([person.personId]), {
      action: t("admin.resetSecondFactor.reauthAction", { name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name }));
    toast.show(t("admin.resetSecondFactor.done", { name }));
    onClose();
  }

  const lines = ["signedOut", "setsUp", "tokens", "alert", ...(peer ? ["peer"] : [])];
  return (
    <Dialog
      title={t("admin.resetSecondFactor.title", { name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.invite.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={reset.isPending}
            onClick={() => void submit()}
          >
            {t("admin.resetSecondFactor.reset")}
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-1.5 text-md text-ink">
        {lines.map((k) => (
          <li key={k} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-muted" />
            {t(`admin.resetSecondFactor.${k}`, { name })}
          </li>
        ))}
      </ul>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
