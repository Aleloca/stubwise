import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "./api";
import { BusyLabel, ErrorLine, Heading, Notice, errorKey, secondaryButton } from "./ui";
import { useVaultStatus } from "./useStatus";

// `#/passkeys` della pagina a sé (design §10): quali passkey aprono la
// cassaforte, e «Use for the vault» per una registrata dopo la propria
// chiave. Due tocchi: prima una passkey che la apre già, poi questa.
// Registrare o togliere una passkey resta in Preferenze → Security.

export function PasskeysPage() {
  const { t } = useTranslation();
  const { status: s, error, reload } = useVaultStatus();
  const [passkeys, setPasskeys] = useState<{ id: string; name: string }[] | null>(null);
  const [listError, setListError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.myPasskeys().then(setPasskeys, () => setListError(true));
  }, []);

  async function add(p: { id: string; name: string }) {
    setFailure(null);
    setNotice(null);
    setBusy(p.id);
    const out = await api.addPasskeyToVault(p.id);
    setBusy(null);
    if (out.ok) setNotice(t("vault.setup.seal.done", { name: p.name }));
    else if (out.code !== "passkey_failed") setFailure(out.code);
    await reload();
  }

  return (
    <>
      <Heading title={t("vault.setup.page.passkeys")} lead={t("vault.setup.page.passkeysLead")} />
      {error || listError ? (
        <ErrorLine>{t("vault.setup.statusFailed")}</ErrorLine>
      ) : !s || !passkeys ? (
        <p aria-busy="true" className="text-md text-ink-muted">
          {t("vault.setup.page.loading")}
        </p>
      ) : !s.activated || s.key === "none" ? (
        <p className="text-md text-ink">{t("vault.setup.page.passkeysNoKey")}</p>
      ) : passkeys.length === 0 ? (
        <p className="text-md text-ink">{t("vault.setup.errors.no_passkeys")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {notice && <Notice>{notice}</Notice>}
          <ul className="flex flex-col">
            {passkeys.map((p) => {
              const sealed = s.sealedPasskeyIds.includes(p.id);
              return (
                <li key={p.id} className="flex min-h-11 items-center gap-3 border-b border-rule py-1 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-md text-ink" title={p.name}>
                    {p.name}
                  </span>
                  {sealed ? (
                    <span className="text-sm text-ink-muted">{t("vault.setup.seal.sealed")}</span>
                  ) : s.sealedPasskeyIds.length > 0 ? (
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={t("vault.setup.seal.aria", { name: p.name })}
                      title={t("vault.setup.seal.hint")}
                      disabled={busy !== null}
                      onClick={() => void add(p)}
                    >
                      <BusyLabel busy={busy === p.id} idle={t("vault.setup.seal.action")} pending={t("vault.setup.seal.pending")} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-ink-muted">{t("vault.setup.seal.hint")}</p>
          {failure && <ErrorLine>{t(errorKey(failure))}</ErrorLine>}
        </div>
      )}
    </>
  );
}
