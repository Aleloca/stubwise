import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as setup from "@backend/vault-setup";
import { useEntryGate } from "../../../data/queries";
import { useViewer } from "../../../data/viewing";
import { ReauthHost } from "../../../layout/ReauthDialog";
import { useReauth } from "../../../layout/useReauth";
import { formatDateTime } from "../../../notifications/time";
import { useToast } from "../../../tasks-ui/Toast";
import { BusyLabel, EntryColumn, EntryHeading, ErrorLine, TotpInput } from "../../entry/parts";
import { LoginSteps } from "../../entry/LoginPage";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { useOpenVault } from "../VaultBar";
import { RecoveryKitPanel } from "./RecoveryKitPanel";
import { setupErrorKey, useVaultChanged, useVaultSetupStatus } from "./useVaultSetup";

// `/app/#/vault-setup` (design della cassaforte nel browser §10, fase 2): la
// pagina minima dedicata, fuori dall'intelaiatura dell'app (niente chat,
// posta, riquadro di Claude). Solo nella build web: il router non la
// registra altrove. Attivare la cassaforte col kit di recupero, creare (o
// ricreare) la propria chiave, ruotare il kit, il recupero col kit. Gli
// stessi passi e gli stessi testi del web vecchio (`apps/web/src/routes/
// vault-setup.tsx` e `vault-recovery.tsx`); la crittografia sta nel worker.

export function VaultSetupPage() {
  const { t } = useTranslation();
  const { stage } = useEntryGate();
  const [finishing, setFinishing] = useState(false);
  return (
    <EntryColumn>
      <EntryHeading title={t("vault.setup.title")} lead={t("vault.setup.subtitle")} />
      {stage !== "in" || finishing ? (
        <>
          <p className="mb-4 text-sm text-ink-muted">{t("vault.setup.signInFirst")}</p>
          <LoginSteps onFinishing={setFinishing} onDone={() => setFinishing(false)} />
        </>
      ) : (
        <SetupBody />
      )}
      {/* «Confirm it's you»: fuori dall'intelaiatura dell'app, si monta qui. */}
      <ReauthHost />
    </EntryColumn>
  );
}

/** Una riconferma annullata non è un errore: niente è cambiato. */
const cancelled = (r: { ok: boolean; error?: string }) => !r.ok && r.error === "reauth_cancelled";

function SetupBody() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const fullAdmin = viewer.instancePermissions.includes("instance.full_admin");
  const status = useVaultSetupStatus();

  if (!setup.vaultSetupAvailable) return <p className="text-md text-ink">{t("vault.setup.unavailable")}</p>;
  if (status.isError)
    return (
      <ErrorLine
        action={
          <button type="button" className={`${secondaryButton} ml-2`} onClick={() => void status.refetch()}>
            {t("vault.setup.retry")}
          </button>
        }
      >
        {t("vault.setup.statusFailed")}
      </ErrorLine>
    );
  const s = status.data;
  if (!s) return <p aria-busy="true" className="text-md text-ink-muted">…</p>;

  if (!s.activated)
    return fullAdmin ? <Activate /> : <p className="text-md text-ink">{t("vault.setup.inactive")}</p>;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <p className="text-md text-ink">{t("vault.setup.active")}</p>
        <OwnKey keyState={s.key} sealed={s.sealedPasskeyIds.length} />
        <p className="text-sm text-ink-muted">{t("vault.setup.passkeysHint")}</p>
        <div className="flex flex-wrap gap-2">
          <a className={secondaryButton} href="#/vault">
            {t("vault.setup.toVault")}
          </a>
          <a className={secondaryButton} href="#/preferences/security">
            {t("vault.setup.toSecurity")}
          </a>
        </div>
      </section>
      {fullAdmin && s.key === "confirmed" && <RotateKit />}
      {fullAdmin && <Recovery />}
    </div>
  );
}

/**
 * L'attivazione (solo full admin): il kit nasce nel worker e si mostra una
 * volta; dopo «I printed/saved the kit», la passkey (una senza PRF ferma
 * tutto PRIMA di attivare), l'attivazione con la riconferma se serve, e la
 * chiave di chi attiva nello stesso giro. Se l'attivazione è passata e la
 * chiave no, la pagina mostra «Create your key».
 */
function Activate() {
  const { t } = useTranslation();
  const run = useReauth();
  const changed = useVaultChanged();
  const [kit, setKit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lasciando la pagina col kit non usato, il worker lo butta.
  useEffect(() => () => void setup.forgetKit(), []);

  async function generate() {
    setError(null);
    setBusy(true);
    const out = await setup.generateKit("activate");
    setBusy(false);
    if (out.ok) setKit(out.kitText);
    else setError(out.code);
  }

  async function activate() {
    setError(null);
    setBusy(true);
    const out = await run(() => setup.activateVault(), { action: t("vault.setup.activate").toLowerCase() });
    setBusy(false);
    // Il kit si mostra una volta: attivata (anche se la chiave è da rifare) o
    // attivata da altri, il testo sparisce. Una passkey senza PRF o annullata
    // lo lascia: l'attivazione non è partita.
    if (out.ok || (!out.ok && "code" in out && (out.code === "vault_already_active" || out.code === "no_prf"))) setKit(null);
    if (!out.ok && !cancelled(out)) setError("code" in out ? out.code : "failed");
    await changed();
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
        {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-md text-ink">{t("vault.setup.intro")}</p>
      <p className="text-sm text-ink-muted">{t("vault.setup.warning")}</p>
      {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
      <button type="button" className={`${primaryButton} self-start`} disabled={busy} onClick={() => void generate()}>
        {t("vault.setup.generate")}
      </button>
    </div>
  );
}

/** La propria chiave: crearla, aspettare la conferma, o ricrearla se nessuna passkey la apre più. */
function OwnKey({ keyState, sealed }: { keyState: "none" | "pending" | "confirmed"; sealed: number }) {
  const { t } = useTranslation();
  const changed = useVaultChanged();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function create(recreate: boolean) {
    setError(null);
    setBusy(true);
    const out = await setup.createVaultKey(recreate ? { recreate: true } : {});
    setBusy(false);
    if (out.ok) setReady(true);
    else setError(out.code);
    await changed();
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
      {ready && <p className="text-md text-positive">{t("vault.setup.keyReady")}</p>}
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
      {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
    </div>
  );
}

/**
 * La rotazione del kit (full admin, chiave confermata): l'anteprima prima del
 * kit (con una credenziale senza la propria copia non si ruota, e la pagina
 * dice quali), poi il kit nuovo una volta; la sostituzione vuole la
 * cassaforte aperta: chiusa, si apre con la passkey e si riprova.
 */
function RotateKit() {
  const { t } = useTranslation();
  const changed = useVaultChanged();
  const { open } = useOpenVault();
  const [kit, setKit] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ id: string; service: string; label: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => () => void setup.forgetKit(), []);

  async function start() {
    setError(null);
    setDone(false);
    setMissing([]);
    setBusy(true);
    const out = await setup.generateKit("rotate");
    setBusy(false);
    if (out.ok) return setKit(out.kitText);
    if (out.code === "missing" && "missing" in out && out.missing) return setMissing(out.missing);
    setError(out.code);
  }

  async function replace() {
    setError(null);
    setBusy(true);
    let out = await setup.rotateRecoveryKit();
    // Chiusa (o la finestra dello sblocco è scaduta): si apre e si riprova, una volta.
    if (!out.ok && (out.code === "vault_locked" || out.code === "vault_unlock_required") && (await open()))
      out = await setup.rotateRecoveryKit();
    setBusy(false);
    if (out.ok) {
      setKit(null);
      setDone(true);
    } else if (out.code === "missing" && "missing" in out) {
      setKit(null);
      setMissing((out as { missing: typeof missing }).missing);
    } else if (out.code !== "vault_locked") setError(out.code);
    await changed();
  }

  async function cancel() {
    await setup.forgetKit();
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
          {done && <p className="text-md text-positive">{t("vault.setup.rotate.done")}</p>}
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
      {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
    </section>
  );
}

/**
 * Il recupero col kit (full admin, con la riconferma): il testo incollato va
 * al worker e lascia subito lo stato della pagina; al server solo la prova.
 * Il kit serve SOLO a confermare accessi in attesa, una persona alla volta,
 * e non mostra mai una password. «Done» o lasciare la pagina lo dimenticano.
 */
function Recovery() {
  const { t, i18n } = useTranslation();
  const run = useReauth();
  const toast = useToast();
  const changed = useVaultChanged();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [items, setItems] = useState<setup.RecoveryPerson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  /** La persona per cui serve il codice (nessuna passkey): il campo compare nella sua scheda. */
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(
    () => () => {
      if (loaded.current) void setup.forgetRecoveryKit();
    },
    [],
  );

  async function use() {
    const kitText = text;
    // Letto: il testo esce dallo stato della pagina; lo tiene il worker.
    setText("");
    setError(null);
    setBusy("load");
    const out = await run(() => setup.loadRecoveryKit(kitText), { action: t("vault.setup.recovery.title").toLowerCase() });
    setBusy(null);
    if (out.ok) {
      loaded.current = true;
      setItems(out.items);
    } else if (!cancelled(out)) setError("code" in out ? out.code : "failed");
  }

  /**
   * I-1: ogni conferma vuole una presenza fresca, verificata dal worker: la
   * passkey (senza PRF) o, se la persona non ne ha, il codice dell'app,
   * chiesto qui per QUELLA conferma e poi dimenticato.
   */
  async function confirm(person: setup.RecoveryPerson, withCode?: string) {
    setError(null);
    setBusy(person.personKeyId);
    const out = await setup.confirmWithRecoveryKit(person.personKeyId, withCode);
    setBusy(null);
    setCode("");
    if (!out.ok && out.code === "code_required") return setCodeFor(person.personKeyId);
    setCodeFor(null);
    if (out.ok) {
      toast.show(t("vault.setup.recovery.saved", { count: out.saved, name: person.email }));
      if (out.keyChanged + out.notAllowed > 0)
        toast.show(t("vault.setup.recovery.skipped", { count: out.keyChanged + out.notAllowed }));
      setItems((current) => out.items ?? current?.filter((p) => p.personKeyId !== person.personKeyId) ?? null);
      await changed();
    } else setError(out.code);
  }

  async function done() {
    await setup.forgetRecoveryKit();
    loaded.current = false;
    setItems(null);
    setText("");
    setError(null);
    setOpen(false);
  }

  const errorText =
    error === "invalid_kit"
      ? t("vault.setup.recovery.invalidKit")
      : error === "wrong_kit"
        ? t("vault.setup.recovery.wrongKit")
        : error
          ? t(setupErrorKey(error))
          : null;

  return (
    <section aria-labelledby="vault-recovery" className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 id="vault-recovery" className="text-lg font-semibold text-ink">
        {t("vault.setup.recovery.title")}
      </h2>
      <p className="text-sm text-ink-muted">{t("vault.setup.recovery.subtitle")}</p>
      {!open ? (
        <button type="button" className={`${secondaryButton} self-start`} onClick={() => setOpen(true)}>
          {t("vault.setup.recovery.open")}
        </button>
      ) : items ? (
        <div className="flex flex-col gap-3">
          <p className="text-md text-ink">{items.length === 0 ? t("vault.setup.recovery.empty") : t("vault.setup.recovery.loaded")}</p>
          <ul className="flex flex-col">
            {items.map((p) => (
              <li key={p.personKeyId} className="flex flex-col gap-1 border-b border-rule py-3 last:border-b-0">
                <span className="text-md font-medium text-ink">{p.email}</span>
                <span className="text-sm text-ink-muted">
                  {p.device
                    ? t("vault.setup.recovery.key", { created: formatDateTime(p.createdAt, i18n.language), device: p.device })
                    : t("vault.setup.recovery.keyNoDevice", { created: formatDateTime(p.createdAt, i18n.language) })}
                </span>
                <span className="text-sm text-ink-muted">
                  {t("vault.setup.recovery.fingerprint")} <span className="num font-mono text-ink">{p.fingerprint}</span>
                </span>
                <span className="text-sm text-ink-muted">{t("vault.setup.recovery.credentials", { count: p.credentials.length })}</span>
                {codeFor === p.personKeyId && (
                  <>
                    <p className="text-sm text-ink-muted">{t("vault.setup.recovery.codeHint")}</p>
                    <TotpInput label={t("vault.setup.recovery.codeLabel")} value={code} onChange={setCode} autoFocus />
                  </>
                )}
                <button
                  type="button"
                  className={`${primaryButton} mt-1 self-start disabled:opacity-40`}
                  aria-label={t("vault.setup.recovery.confirmAria", { name: p.email })}
                  disabled={busy !== null || (codeFor === p.personKeyId && code.length !== 6)}
                  onClick={() => void confirm(p, codeFor === p.personKeyId ? code : undefined)}
                >
                  <BusyLabel
                    busy={busy === p.personKeyId}
                    idle={t("vault.setup.recovery.confirm")}
                    pending={t("vault.setup.recovery.confirming")}
                  />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={`${secondaryButton} self-start`} onClick={() => void done()}>
            {t("vault.setup.recovery.done")}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void use();
          }}
        >
          <label htmlFor="vault-recovery-kit" className="text-sm font-medium text-ink">
            {t("vault.setup.recovery.kitLabel")}
          </label>
          <textarea
            id="vault-recovery-kit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby="vault-recovery-kit-hint"
            autoComplete="off"
            spellCheck={false}
            rows={5}
            className="num rounded-md border border-rule-strong bg-ground px-3 py-2 font-mono text-md text-ink"
          />
          <p id="vault-recovery-kit-hint" className="text-sm text-ink-muted">
            {t("vault.setup.recovery.kitHint")}
          </p>
          <button
            type="submit"
            className={`${primaryButton} self-start disabled:opacity-40`}
            disabled={busy !== null || text.trim() === ""}
          >
            <BusyLabel busy={busy === "load"} idle={t("vault.setup.recovery.use")} pending={t("vault.setup.recovery.using")} />
          </button>
        </form>
      )}
      {errorText && <ErrorLine>{errorText}</ErrorLine>}
    </section>
  );
}
