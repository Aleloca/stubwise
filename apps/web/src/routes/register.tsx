import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { AuthShell } from "../components/auth-shell";
import { FormError, SubmitButton, TextField } from "../components/field";
import { postLogin, postRegister } from "../lib/api";
import { meQueryOptions } from "../lib/auth";

/** Il token arriva nel link di invito: /register?token=… */
export const registerSearchSchema = z.object({
  token: z.string().min(1).optional().catch(undefined),
});

const route = getRouteApi("/register");

/**
 * Registrazione su invito (pagina pubblica). Il POST /register non apre la
 * sessione: dopo il 201 si fa un login esplicito con le stesse credenziali,
 * come per il primo setup.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = route.useSearch();

  const [token, setToken] = useState(search.token ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await postRegister({ email, password, token });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Errore imprevisto");
      setPending(false);
      return;
    }
    try {
      const { user } = await postLogin({ email, password });
      queryClient.setQueryData(meQueryOptions.queryKey, { user });
      await navigate({ to: "/tickets" });
    } catch {
      // L'account esiste e l'invito è consumato: ritentare il form sarebbe
      // peggio (il token non vale più), si passa al login manuale.
      await navigate({ to: "/login" });
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Crea il tuo account"
      subtitle="Sei stato invitato su questa istanza Stubwise."
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <TextField
          id="register-token"
          label="Token di invito"
          type="text"
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <TextField
          id="register-email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          id="register-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>
          {pending ? "Registrazione…" : "Registrati"}
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
