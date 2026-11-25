import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useCredentials, useCredentialsEntry, useProject } from "../../data/queries";
import { secondaryButton } from "../tasks/controls";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { ListSkeleton } from "../servers/ServersPage";
import { CredentialRows } from "./CredentialRows";
import { VaultBar } from "./VaultBar";

// La sezione Credentials di un progetto (`#/p/ACQ/credentials`, shape
// `vault.md` §3, lotto 10): la barra della cassaforte in testa, poi le
// credenziali che chi guarda vede, come le altre liste del progetto (righe
// e filetti, niente card).

export function CredentialsSection({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  const project = useProject(projectCode).data ?? undefined;
  const rows = useCredentials({ projectId: project?.id }, !!project);
  const entry = useCredentialsEntry(project?.id).data;
  const navigate = useNavigate();
  const newCredential = () =>
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({ ...prev, credential: "new" })) as never,
    });

  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[1120px] flex-col gap-6 pr-8">
        <header className="page-header flex shrink-0 items-start gap-4 [--page-header-pr:0px] [--page-header-pt:32px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-2xl font-semibold text-ink">{t("vault.title")}</h1>
            <p className="max-w-[72ch] text-md text-ink-muted">
              {t("vault.subtitle", { code: projectCode })}
            </p>
          </div>
          {entry?.canCreate && (
            <button type="button" className={secondaryButton} onClick={newCredential}>
              {t("vault.new")}
            </button>
          )}
        </header>
        <VaultBar />
        {rows.isError ? (
          <PageError message={t("vault.errors.list")} onRetry={() => void rows.refetch()} />
        ) : !rows.data ? (
          <ListSkeleton />
        ) : rows.data.length === 0 ? (
          <PageEmpty title={t("vault.empty")} />
        ) : (
          <CredentialRows rows={rows.data} />
        )}
      </div>
    </section>
  );
}
