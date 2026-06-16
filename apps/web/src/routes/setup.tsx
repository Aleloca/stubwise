import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AuthShell } from "../components/auth-shell";
import { FormError, SubmitButton, TextField } from "../components/field";
import { postLogin, postSetup } from "../lib/api";
import { meQueryOptions } from "../lib/auth";

/**
 * Primo avvio: crea l'account amministratore. Il POST /setup non apre la
 * sessione lato server, quindi dopo il 201 si fa un login esplicito con le
 * stesse credenziali prima di entrare nell'app.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // Verifica solo lato client: il server non conosce il campo conferma.
    if (password !== confirm) {
      setError(t("auth:setup.passwordMismatch"));
      return;
    }
    setPending(true);
    try {
      const credentials = { email, password };
      await postSetup(credentials);
      await postLogin(credentials);
      // La lingua dell'utente arriva solo da `/me`: la guardia del layout la
      // rifetcha prima del render, niente prime di una cache `me` incompleta.
      queryClient.removeQueries({ queryKey: meQueryOptions.queryKey });
      await navigate({ to: "/tickets" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell title={t("auth:setup.title")} subtitle={t("auth:setup.subtitle")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <TextField
          id="email"
          label={t("auth:fields.email")}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          id="password"
          label={t("auth:fields.password")}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          id="confirm-password"
          label={t("auth:setup.confirmLabel")}
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>
          {pending ? t("auth:setup.submitPending") : t("auth:setup.submit")}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
