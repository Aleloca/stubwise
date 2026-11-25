import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCopyPassword, useShowPassword, useVaultStatus } from "../../data/queries";
import type { CredentialView } from "../../data/vault/types";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton } from "../tasks/controls";
import { useOpenVault } from "./VaultBar";

// Le righe delle credenziali (shape `vault.md` §3): servizio, utente, la
// password in pallini e, aperta, «Show» e «Copy». La password mostrata sta
// SOLO nello stato di questa lista (mai in una cache), resta finché non si
// preme «Hide» (VA-Q3, maintainer) e sparisce quando la cassaforte si
// chiude. «Copy» non riceve la password: gli appunti li scrive il livello
// dati (nell'app, il main). A cassaforte chiusa, «Show» e «Copy» aprono col
// Touch ID e poi fanno l'azione (VA-Q2).

const DOTS = "••••••••••";

export function CredentialRows({
  rows,
  projectCodeOf,
}: {
  rows: CredentialView[];
  /** Nella pagina Vault: il codice del progetto prima del servizio. */
  projectCodeOf?: (projectId: string) => string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const status = useVaultStatus().data;
  const { open } = useOpenVault();
  const show = useShowPassword();
  const copy = useCopyPassword();
  const [shown, setShown] = useState<Record<string, string>>({});
  const state = status?.state;
  // Chiusa (per tempo, stop, schermo, «Lock»): ogni password mostrata torna pallini.
  useEffect(() => {
    if (state !== "open") setShown({});
  }, [state]);
  // A chiusa i gesti aprono prima; da associare, revocata o senza Touch ID non c'è niente da aprire qui.
  const usable = state === "open" || (state === "locked" && status?.touchId);

  const ensureOpen = async () => state === "open" || (await open());

  const onShow = async (row: CredentialView) => {
    if (!(await ensureOpen())) return;
    const out = await show.mutateAsync(row.id).catch(() => null);
    if (out?.ok) setShown((m) => ({ ...m, [row.id]: out.password }));
    else toast.error(t("vault.revealFailed"));
  };
  const onCopy = async (row: CredentialView) => {
    if (!(await ensureOpen())) return;
    const out = await copy.mutateAsync(row.id).catch(() => null);
    if (out?.ok) toast.show(t("vault.copied"));
    else toast.error(t("vault.revealFailed"));
  };

  return (
    <ul className="border-t border-rule">
      {rows.map((row) => {
        const password = shown[row.id];
        return (
          <li
            key={row.id}
            data-credential={row.id}
            className="flex min-h-11 items-center gap-4 border-b border-rule px-3 py-1.5"
          >
            {projectCodeOf && (
              <span className="num w-12 shrink-0 text-sm font-semibold text-ink-muted">
                {projectCodeOf(row.projectId)}
              </span>
            )}
            <span className="flex w-56 min-w-0 shrink-0 flex-col">
              <span className="truncate text-md font-semibold text-ink">{row.service}</span>
              {row.label && <span className="truncate text-sm text-ink-muted">{row.label}</span>}
            </span>
            <span
              className="w-48 min-w-0 shrink-0 truncate text-md text-ink"
              title={row.username ?? undefined}
            >
              {row.username}
            </span>
            {row.access === "reads" ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[15px] text-ink"
                  aria-label={
                    password
                      ? t("vault.row.passwordOf", { name: row.service })
                      : t("vault.row.hidden")
                  }
                  data-password={password ? "shown" : "hidden"}
                >
                  {password ?? DOTS}
                </span>
                {password && (
                  <span className="sr-only" aria-live="polite">
                    {t("vault.row.shownLive")}
                  </span>
                )}
                <span className="flex shrink-0 items-center gap-1">
                  {password ? (
                    <button
                      type="button"
                      className={quietButton}
                      aria-label={t("vault.row.hideAria", { name: row.service })}
                      onClick={() =>
                        setShown((m) => {
                          const next = { ...m };
                          delete next[row.id];
                          return next;
                        })
                      }
                    >
                      {t("vault.row.hide")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={quietButton}
                      disabled={!usable}
                      aria-label={t("vault.row.showAria", { name: row.service })}
                      onClick={() => void onShow(row)}
                    >
                      {t("vault.row.show")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={quietButton}
                    disabled={!usable}
                    aria-label={t("vault.row.copyAria", { name: row.service })}
                    onClick={() => void onCopy(row)}
                  >
                    {t("vault.row.copy")}
                  </button>
                </span>
              </>
            ) : (
              <span className="min-w-0 flex-1 text-md text-ink-muted" data-access={row.access}>
                {row.access === "waiting" ? t("vault.row.waiting") : t("vault.row.manages")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
