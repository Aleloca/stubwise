import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuthShell } from "../components/auth-shell";
import { LoginForm } from "../components/login-form";
import { postLogin } from "../lib/api";
import type { Credentials } from "../lib/api";
import { meQueryOptions } from "../lib/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  async function handleSubmit(credentials: Credentials) {
    await postLogin(credentials);
    // La risposta di login non porta la lingua dell'utente (la espone solo
    // `/me`): la guardia del layout autenticato fa la fetch di `/me` prima del
    // render, così l'identità in cache è completa e i18n può allinearsi.
    queryClient.removeQueries({ queryKey: meQueryOptions.queryKey });
    await navigate({ to: "/tickets" });
  }

  return (
    <AuthShell title={t("auth:login.title")} subtitle={t("auth:login.subtitle")}>
      <LoginForm onSubmit={handleSubmit} />
    </AuthShell>
  );
}
