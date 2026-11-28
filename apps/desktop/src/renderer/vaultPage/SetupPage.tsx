import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "./api";
import { RecoveryKitPanel } from "./RecoveryKitPanel";
import { useReauthRun } from "./reauth";
import { BusyLabel, ErrorLine, Heading, Notice, errorKey, primaryButton, secondaryButton } from "./ui";
import { useVaultStatus } from "./useStatus";

// `#/setup` della pagina a sé (design §10): attivare la cassaforte col kit
// di recupero (solo full admin), creare o ricreare la propria chiave,
// rigenerare il kit. Gli stessi passi e testi del web vecchio
// (`apps/web/src/routes/vault-setup.tsx`); la crittografia sta nel worker.

export function SetupPage({ me }: { me: api.Me }) {
  const { t } = useTranslation();
  const { status: s, error, reload } = useVaultStatus();
  return (
    <>
      <Heading title={t("vault.setup.title")} lead={t("vault.setup.subtitle")} />
      {error ? (
        <ErrorLine>{t("vault.setup.statusFailed")}</ErrorLine>
      ) : !s ? (
        <p aria-busy="true" className="text-md text-ink-muted">
          {t("vault.setup.page.loading")}
        </p>
      ) : !s.activated ? (
        me.fullAdmin ? (
          <Activate onChanged={reload} />
        ) : (
          <p className="text-md text-ink">{t("vault.setup.inactive")}</p>
        )
      ) : (
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <p className="text-md text-ink">{t("vault.setup.active")}</p>
            <OwnKey keyState={s.key} sealed={s.sealedPasskeyIds.length} onChanged={reload} />
            <p className="text-sm text-ink-muted">{t("vault.setup.page.passkeysHint")}</p>
          </section>
          {me.fullAdmin && s.key === "confirmed" && <RotateKit onChanged={reload} />}
        </div>
      )}
    </>
  );
}

/**
 * L'attivazione: il kit nasce nel worker e si mostra una volta; dopo «I
 * printed/saved the kit», la passkey (una senza PRF ferma tutto PRIMA di
 * attivare), la riconferma se serve, e la chiave di chi attiva.
 */
function Activate({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const { run, panel } = useReauthRun();
  const [kit, setKit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void api.forgetKit(), []);

  async function generate() {
    setError(null);
    setBusy(true);
    const out = await api.generateKit("activate");
    setBusy(false);
    if (out.ok) setKit(out.kitText);
    else setError(out.code);
  }

  async function activate() {
    setError(null);
    setBusy(true);
    const out = await run(() => api.activateVault());
    setBusy(false);
    // Il kit si mostra una volta: attivata (anche se la chiave è da rifare) o
    // attivata da altri, il testo sparisce. Una passkey senza PRF o annullata lo lascia.
    if (out.ok || out.code === "vault_already_active" || out.code === "no_prf") setKit(null);
    if (!out.ok && out.code !== "reauth_cancelled") setError(out.code);
    await onChanged();
  }

  if (kit)
    return (
      <div className="flex flex-col gap-3">
        <RecoveryKitPanel
          kitText={kit}
          savedLabel={t("vault.setup.kit.saved")}
          continueLabel={t("vault.setup.activate")}
          pendingLabel={t("vault.setup.activating")}
          pending={busy}
          onConfirm={() => void activate()}
        />
        {panel}
        {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-md text-ink">{t("vault.setup.intro")}</p>
      <p className="text-sm text-ink-muted">{t("vault.setup.warning")}</p>
      {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
      <button type="button" className={`${primaryButton} self-start`} disabled={busy} onClick={() => void generate()}>
        {t("vault.setup.generate")}
      </button>
    </div>
  );
}

/** La propria chiave: crearla, aspettare la conferma, o ricrearla se nessuna passkey la apre più. */
function OwnKey({
  keyState,
  sealed,
  onChanged,
}: {
  keyState: "none" | "pending" | "confirmed";
  sealed: number;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function create(recreate: boolean) {
    setError(null);
    setBusy(true);
    const out = await api.createVaultKey(recreate ? { recreate: true } : {});
    setBusy(false);
    if (out.ok) setReady(true);
    else setError(out.code);
    await onChanged();
  }

  const button = (recreate: boolean) => (
    <button type="button" className={`${primaryButton} self-start`} disabled={busy} onClick={() => void create(recreate)}>
      <BusyLabel
        busy={busy}
        idle={t(recreate ? "vault.setup.recreate.action" : "vault.setup.createKey")}
        pending={t("vault.setup.creating")}
      />
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      {ready && <Notice>{t("vault.setup.keyReady")}</Notice>}
      {keyState === "none" && !ready && (
        <>
          <p className="text-md text-ink">{t("vault.setup.noKey")}</p>
          {button(false)}
        </>
      )}
      {keyState === "pending" && <p className="text-md text-ink">{t("vault.setup.keyPending")}</p>}
      {keyState === "confirmed" && !ready && <p className="text-md text-ink">{t("vault.setup.keyConfirmed")}</p>}
      {keyState !== "none" && sealed === 0 && (
        <>
          <p role="note" className="rounded-md border border-critical/40 bg-critical/8 p-3 text-sm text-ink">
            {t("vault.setup.recreate.warning")}
          </p>
          {button(true)}
        </>
      )}
      {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
    </div>
  );
}

/**
 * La rotazione del kit (full admin, chiave confermata): l'anteprima prima del
 * kit, poi il kit nuovo una volta; la sostituzione vuole la cassaforte
 * aperta: chiusa, si apre con la passkey e si riprova.
 */
function RotateKit({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const [kit, setKit] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ id: string; service: string; label: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => () => void api.forgetKit(), []);

  async function start() {
    setError(null);
    setDone(false);
    setMissing([]);
    setBusy(true);
    const out = await api.generateKit("rotate");
    setBusy(false);
    if (out.ok) return setKit(out.kitText);
    if (out.code === "missing" && "missing" in out && out.missing) return setMissing(out.missing);
    setError(out.code);
  }

  async function replace() {
    setError(null);
    setBusy(true);
    let out = await api.rotateRecoveryKit();
    if (!out.ok && (out.code === "vault_locked" || out.code === "vault_unlock_required")) {
      const opened = await api.openVault();
      if (opened.ok) out = await api.rotateRecoveryKit();
      else out = opened;
    }
    setBusy(false);
    if (out.ok) {
      setKit(null);
      setDone(true);
    } else if (out.code === "missing" && "missing" in out) {
      setKit(null);
      setMissing((out as { missing: typeof missing }).missing);
    } else if (out.code !== "passkey_failed") setError(out.code);
    await onChanged();
  }

  async function cancel() {
    await api.forgetKit();
    setKit(null);
    setError(null);
  }

  return (
    <section aria-labelledby="vault-rotate" className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 id="vault-rotate" className="text-lg font-semibold text-ink">
        {t("vault.setup.rotate.title")}
      </h2>
      {kit ? (
        <>
          <p role="note" className="rounded-md border border-critical/40 bg-critical/8 p-3 text-sm text-ink">
            {t("vault.setup.rotate.warning")}
          </p>
          <RecoveryKitPanel
            kitText={kit}
            savedLabel={t("vault.setup.rotate.saved")}
            continueLabel={t("vault.setup.rotate.replace")}
            pendingLabel={t("vault.setup.rotate.replacing")}
            pending={busy}
            onConfirm={() => void replace()}
          />
          <button type="button" className={`${secondaryButton} self-start`} disabled={busy} onClick={() => void cancel()}>
            {t("vault.setup.rotate.cancel")}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-muted">{t("vault.setup.rotate.intro")}</p>
          {done && <Notice>{t("vault.setup.rotate.done")}</Notice>}
          {missing.length > 0 && (
            <div role="alert" className="flex flex-col gap-1 text-sm text-ink">
              <p>{t("vault.setup.rotate.missing")}</p>
              <ul className="list-disc pl-5">
                {missing.map((m) => (
                  <li key={m.id}>{m.label ? `${m.service} · ${m.label}` : m.service}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className={`${secondaryButton} self-start`} disabled={busy} onClick={() => void start()}>
            {t("vault.setup.rotate.action")}
          </button>
        </>
      )}
      {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
    </section>
  );
}
