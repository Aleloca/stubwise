import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AuthShell } from "../components/auth-shell";
import { LoginForm } from "../components/login-form";
import { postLogin } from "../lib/api";
import type { Credentials } from "../lib/api";
import { meQueryOptions } from "../lib/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSubmit(credentials: Credentials) {
    const { user } = await postLogin(credentials);
    // La cache di `me` viene riempita subito: la guardia del layout
    // autenticato non rifarà la richiesta appena atterrati su /tickets.
    queryClient.setQueryData(meQueryOptions.queryKey, { user });
    await navigate({ to: "/tickets" });
  }

  return (
    <AuthShell title="Accedi" subtitle="Entra nella tua istanza Stubwise.">
      <LoginForm onSubmit={handleSubmit} />
    </AuthShell>
  );
}
