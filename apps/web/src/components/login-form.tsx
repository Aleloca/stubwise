import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Credentials } from "../lib/api";
import { FormError, SubmitButton, TextField } from "./field";

interface LoginFormProps {
  /** Esegue il login; un rigetto (tipicamente ApiError 401) mostra l'errore. */
  onSubmit: (credentials: Credentials) => Promise<void>;
}

/**
 * Form di login puro: la chiamata API e la navigazione sono iniettate via
 * `onSubmit`, così il componente si testa in isolamento.
 */
export function LoginForm({ onSubmit }: LoginFormProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit({ email, password });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
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
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("auth:login.submitPending") : t("auth:login.submit")}
      </SubmitButton>
    </form>
  );
}
