import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CredentialGroups, KeyPendingNotice } from "../components/vault/credentials-section";
import { FormError } from "../components/field";
import type { CredentialItem } from "../lib/api";
import { myCredentialsQueryOptions, projectsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { useVault } from "../lib/vault/vault-context";

/**
 * «Le mie credenziali» (design «Dove sta nella web»): tutte quelle che chi
 * guarda può leggere — o aspetta di leggere — in tutti i progetti,
 * raggruppate per progetto e servizio. Solo Mostra / Copia: modifica,
 * lettori e registro stanno nella sezione «Credenziali» del progetto.
 */
export function MyCredentialsPage() {
  const { t } = useTranslation();
  const vault = useVault();
  const active = vault.state !== "inactive";
  const credentials = useQuery({ ...myCredentialsQueryOptions, enabled: active });
  const projects = useQuery({ ...projectsQueryOptions, enabled: active });

  const byProject = new Map<string, CredentialItem[]>();
  for (const item of credentials.data?.items ?? []) {
    const group = byProject.get(item.projectId) ?? [];
    group.push(item);
    byProject.set(item.projectId, group);
  }
  const projectName = (id: string) =>
    projects.data?.find((project) => project.id === id)?.name ?? id;
  const groups = [...byProject].sort(([a], [b]) => projectName(a).localeCompare(projectName(b)));

  return (
    <div className="page mx-auto w-full max-w-5xl">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-[0.02em] text-fg uppercase">
          {t("vault:credentials.mine.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          {t("vault:credentials.mine.subtitle")}
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-6">
        {!active ? (
          <p className="font-mono text-[12px] text-fg-faint">
            {t("vault:credentials.mine.inactive")}
          </p>
        ) : (
          <>
            <KeyPendingNotice />
            {credentials.isPending ? (
              <p className="font-mono text-[12px] text-fg-faint">
                {t("vault:credentials.loading")}
              </p>
            ) : credentials.isError ? (
              <FormError message={translateApiError(credentials.error, t)} />
            ) : groups.length === 0 ? (
              <p className="font-mono text-[12px] text-fg-faint">
                {t("vault:credentials.mine.empty")}
              </p>
            ) : (
              groups.map(([projectId, items]) => (
                <section
                  key={projectId}
                  aria-label={projectName(projectId)}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                    <h2 className="font-mono text-[12px] tracking-[0.18em] text-fg-muted uppercase">
                      {projectName(projectId)}
                    </h2>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId }}
                      className="font-mono text-[11px] text-signal underline"
                    >
                      {t("vault:credentials.mine.openProject")}
                    </Link>
                  </div>
                  <CredentialGroups items={items} manage={false} />
                </section>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
