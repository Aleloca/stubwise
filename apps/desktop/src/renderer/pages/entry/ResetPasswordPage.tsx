import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  MIN_PASSWORD_LENGTH,
  useResetLink,
  useResetPassword,
  type ResetLinkStatus,
} from "../../data/queries";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine, textButton } from "./parts";

/**
 * `/reset-password/$token` (come `apps/web/src/routes/reset-password.tsx`):
 * il link che chi gestisce le persone ha creato e mandato. Valido, si sceglie
 * la password nuova: il link non vale più, ogni sessione della persona si
 * chiude (anche questa, se è sua: l'app esce) e si entra dal login. Usato o
 * scaduto (una frase sola, come il server) o sconosciuto lo dicono in parole,
 * senza nomi: un link inventato non rivela niente.
 */
export function ResetPasswordPage({ token }: { token: string }) {
  const { t } = useTranslation();
  const link = useResetLink(token);
  return (
    <EntryColumn>
      {link.isPending ? (
        <div aria-busy="true" aria-label={t("entry.reset.loading")} className="mb-6">
          <div className="h-8 w-56 animate-pulse rounded-md bg-ink/8 motion-reduce:animate-none" />
          <div className="mt-3 h-4 w-72 animate-pulse rounded-md bg-ink/6 motion-reduce:animate-none" />
        </div>
      ) : link.isError ? (
        <>
          <EntryHeading title={t("entry.reset.title")} />
          <ErrorLine
            action={
              <button
                type="button"
                className={`${textButton} ml-1`}
                onClick={() => void link.refetch()}
              >
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.reset.loadFailed")}
          </ErrorLine>
        </>
      ) : link.data.status === "valid" ? (
        <ResetForm token={token} />
      ) : (
        <NotValid status={link.data.status} />
      )}
    </EntryColumn>
  );
}

function NotValid({ status }: { status: Exclude<ResetLinkStatus, "valid"> }) {
  const { t } = useTranslation();
  return (
    <section data-reset-status={status}>
      <EntryHeading title={t(`entry.reset.${status}Title`)} lead={t(`entry.reset.${status}Body`)} />
      <Link to="/login" className={`${textButton} text-sm`}>
        {t("entry.register.goToSignIn")}
      </Link>
    </section>
  );
}

function ResetForm({ token }: { token: string }) {
  const { t } = useTranslation();
  const reset = useResetPassword();
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const passwordError =
    tried && password.length < MIN_PASSWORD_LENGTH ? t("entry.register.tooShort") : null;
  const confirmError =
    tried && !passwordError && confirm !== password ? t("entry.register.mismatch") : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setRefused(null);
    if (password.length < MIN_PASSWORD_LENGTH || confirm !== password) return;
    reset.mutate(
      { token, password },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            // Il link è cambiato nel frattempo (usato, scaduto) o la password non va.
            setRefused(
              r.error === "invalid_input"
                ? t("entry.register.tooShort")
                : t("entry.reset.noLonger"),
            );
            return;
          }
          void navigate({ to: "/login", replace: true });
          toast.show(t("entry.reset.done"));
        },
      },
    );
  }

  return (
    <>
      <EntryHeading title={t("entry.reset.title")} lead={t("entry.reset.lead")} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <EntryField
          label={t("entry.reset.password")}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.target.value)}
        />
        <EntryField
          label={t("entry.register.confirm")}
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={confirmError}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {refused && <ErrorLine>{refused}</ErrorLine>}
        {reset.isError && <ErrorLine>{t("entry.reset.failed")}</ErrorLine>}
        {/* L'uscita, come sulle pagine senza via [R5]: a sinistra, il bottone a destra. */}
        <div className="flex items-center justify-between gap-4">
          <Link to="/login" className={`${textButton} text-sm`}>
            {t("entry.register.goToSignIn")}
          </Link>
          <button type="submit" className={primaryButton} aria-busy={reset.isPending}>
            <BusyLabel
              busy={reset.isPending}
              idle={t("entry.reset.submit")}
              pending={t("entry.reset.submitting")}
            />
          </button>
        </div>
      </form>
    </>
  );
}
