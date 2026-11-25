import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCredentials, useProjects, useVaultEntry } from "../../data/queries";
import { inputClass } from "../../tasks-ui/Dialog";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { ListSkeleton } from "../servers/ServersPage";
import { secondaryButton } from "../tasks/controls";
import { CredentialRows } from "./CredentialRows";
import { PendingRow } from "./PendingAccess";
import { VaultBar } from "./VaultBar";

// La pagina unica «Vault» (`#/vault`, lotto 10, VA-Q1 «Entrambe», shape
// `vault.md` §3): le credenziali di tutti i progetti di chi guarda, nella
// stessa cornice della sezione. In più: il codice del progetto prima del
// servizio (link alla sezione), la ricerca (servizio, etichetta, utente) e
// il filtro per progetto nell'indirizzo (`?projects=ACQ,MKX`; vuoto = tutti).
// «New credential» chiede il progetto nel pannello.

export function VaultPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { projects?: string };
  const projects = useProjects().data ?? [];
  const entry = useVaultEntry().data;
  const rows = useCredentials({});
  const [query, setQuery] = useState("");

  const codeOf = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.code]));
    return (id: string) => byId.get(id) ?? id;
  }, [projects]);
  const chosen = useMemo(
    () => new Set((search.projects ?? "").split(",").filter(Boolean)),
    [search.projects],
  );
  const all = rows.data ?? [];
  // I progetti del filtro: quelli dove chi guarda ha credenziali, in ordine di codice.
  const codes = [...new Set(all.map((r) => codeOf(r.projectId)))].sort();
  const q = query.trim().toLowerCase();
  const visible = all
    .filter((r) => chosen.size === 0 || chosen.has(codeOf(r.projectId)))
    .filter(
      (r) => q === "" || [r.service, r.label, r.username].some((f) => f?.toLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        codeOf(a.projectId).localeCompare(codeOf(b.projectId)) ||
        a.service.localeCompare(b.service),
    );

  const toggle = (code: string) => {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        projects: next.size ? [...next].sort().join(",") : undefined,
      })) as never,
    });
  };
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
            <h1 className="text-2xl font-semibold text-ink">{t("vault.page.title")}</h1>
            <p className="max-w-[72ch] text-md text-ink-muted">{t("vault.page.subtitle")}</p>
          </div>
          {(entry?.createProjectIds.length ?? 0) > 0 && (
            <button type="button" className={secondaryButton} onClick={newCredential}>
              {t("vault.new")}
            </button>
          )}
        </header>
        <div className="flex flex-col">
          <VaultBar />
          <PendingRow />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            aria-label={t("vault.page.search")}
            placeholder={t("vault.page.search")}
            className={`${inputClass} w-72`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {codes.length > 1 && (
            <div role="group" aria-label={t("vault.page.projects")} className="flex gap-1">
              {codes.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={chosen.has(code)}
                  className="num h-8 rounded-md border border-rule px-2.5 text-sm font-semibold text-ink-muted aria-pressed:border-ink aria-pressed:text-ink"
                  onClick={() => toggle(code)}
                >
                  {code}
                </button>
              ))}
            </div>
          )}
        </div>
        {rows.isError ? (
          <PageError message={t("vault.errors.list")} onRetry={() => void rows.refetch()} />
        ) : !rows.data ? (
          <ListSkeleton />
        ) : all.length === 0 ? (
          <PageEmpty title={t("vault.page.none")} />
        ) : visible.length === 0 ? (
          <PageEmpty title={q ? t("vault.page.noMatch") : t("vault.page.noneProjects")} />
        ) : (
          <CredentialRows rows={visible} projectCodeOf={codeOf} />
        )}
      </div>
    </section>
  );
}
