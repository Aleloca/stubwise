import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AuthShell } from "../components/auth-shell";
import { FormError, SubmitButton, TextField } from "../components/field";
import { getPasswordReset, postPasswordResetConfirm } from "../lib/api";
import { translateApiError } from "../lib/translate-api-error";

const route = getRouteApi("/reset-password/$token");

/**
 * Reset della password da un link emesso da un maintainer (pagina pubblica,
 * `/reset-password/<token>`). Prima chiede al server per quale account vale il
 * link — inesistente, scaduto e già usato sono la stessa risposta, e qui lo
 * stesso messaggio —, poi la password due volte.
 *
 * Il POST non apre una sessione e il server chiude tutte quelle esistenti:
 * dopo il successo si rimanda al login, non si entra da soli.
 */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token } = route.useParams();
  const status = useQuery({
    queryKey: ["password-reset", token],
    queryFn: () => getPasswordReset(token),
    retry: false,
    // Il link non cambia stato da solo mentre la pagina è aperta, e un
    // refetch al focus dopo il successo direbbe «non valido» (è consumato).
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("auth:resetPassword.passwordMismatch"));
      return;
    }
    setPending(true);
    try {
      await postPasswordResetConfirm(token, password);
      setDone(true);
    } catch (cause) {
      setError(translateApiError(cause, t));
    } finally {
      setPending(false);
    }
  }

  const loginLink = (
    <Link
      to="/login"
      className="font-mono text-[12px] tracking-[0.08em] text-signal uppercase hover:text-signal-bright"
    >
      {t("auth:resetPassword.goToLogin")}
    </Link>
  );

  if (done) {
    return (
      <AuthShell
        title={t("auth:resetPassword.successTitle")}
        subtitle={t("auth:resetPassword.success")}
      >
        {loginLink}
      </AuthShell>
    );
  }

  if (status.isPending) {
    return (
      <AuthShell title={t("auth:resetPassword.title")} subtitle={t("auth:resetPassword.loading")}>
        {null}
      </AuthShell>
    );
  }

  if (status.isError) {
    return (
      <AuthShell
        title={t("auth:resetPassword.invalidTitle")}
        subtitle={t("auth:resetPassword.invalid")}
      >
        {loginLink}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth:resetPassword.title")}
      subtitle={t("auth:resetPassword.subtitle", { email: status.data.email })}
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <TextField
          id="reset-password"
          label={t("auth:resetPassword.newPassword")}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          id="reset-password-confirm"
          label={t("auth:resetPassword.confirmPassword")}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>
          {pending ? t("auth:resetPassword.submitPending") : t("auth:resetPassword.submit")}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
