import { useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmItsYou } from "./api";
import { BusyLabel, CodeInput, ErrorLine, errorKey, primaryButton, secondaryButton } from "./ui";

// La riconferma della pagina a sé della cassaforte (I-2): quando un'azione
// risponde `reauth_required`, un riquadro «Confirm it's you» nella pagina (la
// passkey, o il codice se non ce n'è una); confermato, l'azione riparte una
// volta con gli stessi argomenti. La verifica la fa il worker.

type Outcome = { ok: boolean; code?: string };

export function useReauthRun() {
  const [open, setOpen] = useState<((ok: boolean) => void) | null>(null);

  async function run<R extends Outcome>(call: () => Promise<R>): Promise<R | { ok: false; code: "reauth_cancelled" }> {
    const first = await call();
    if (first.ok || first.code !== "reauth_required") return first;
    const confirmed = await new Promise<boolean>((resolve) => setOpen(() => resolve));
    setOpen(null);
    if (!confirmed) return { ok: false, code: "reauth_cancelled" };
    return call();
  }

  const panel = open ? <ConfirmPanel onDone={open} /> : null;
  return { run, panel };
}

function ConfirmPanel({ onDone }: { onDone: (ok: boolean) => void }) {
  const { t } = useTranslation();
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setBusy(true);
    const out = await confirmItsYou(needCode ? code : undefined);
    setBusy(false);
    setCode("");
    if (out.ok) return onDone(true);
    if (out.code === "code_required") return setNeedCode(true);
    if (out.code !== "passkey_failed") setError(out.code);
  }

  return (
    <section
      role="dialog"
      aria-labelledby="vault-confirm-title"
      className="flex flex-col gap-3 rounded-md border border-rule-strong bg-ink/3 p-4"
    >
      <h2 id="vault-confirm-title" className="text-md font-semibold text-ink">
        {t("vault.setup.page.confirmTitle")}
      </h2>
      <p className="text-sm text-ink-muted">{t(needCode ? "vault.setup.page.confirmCode" : "vault.setup.page.confirmLead")}</p>
      {needCode && <CodeInput label={t("vault.setup.recovery.codeLabel")} value={code} onChange={setCode} />}
      {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
      <div className="flex gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={busy || (needCode && code.length !== 6)}
          onClick={() => void confirm()}
        >
          <BusyLabel busy={busy} idle={t("vault.setup.page.confirm")} pending={t("vault.setup.page.confirming")} />
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => onDone(false)}>
          {t("vault.setup.rotate.cancel")}
        </button>
      </div>
    </section>
  );
}
