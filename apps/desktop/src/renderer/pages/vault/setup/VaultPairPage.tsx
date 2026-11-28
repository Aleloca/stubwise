import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as setup from "@backend/vault-setup";
import { useEntryGate } from "../../../data/queries";
import { ReauthHost } from "../../../layout/ReauthDialog";
import { formatDateTime } from "../../../notifications/time";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine } from "../../entry/parts";
import { LoginSteps } from "../../entry/LoginPage";
import { primaryButton } from "../../tasks/controls";
import { setupErrorKey } from "./useVaultSetup";

// `/app/#/vault-pair?state=…` (design della cassaforte dal desktop §6.2 e §7;
// cassaforte nel browser §4 e §10, I7): la pagina del browser che sigilla la
// propria chiave di persona per il Mac che ha chiesto l'associazione. SOLO
// nella build web. Il worker legge l'associazione per `state` e ne calcola
// l'impronta, che qui NON si mostra (M3: si legge sul Mac e si scrive); la
// persona legge l'avviso, riconosce il login del Mac, scrive gli ultimi 4
// caratteri, tocca la passkey, e si torna all'app con `stubwise://vault`.
// Stessi passi e testi del web vecchio (`apps/web/src/routes/vault-pair.tsx`).

const STATE_RE = /^[A-Za-z0-9_-]{1,200}$/;

type Pairing = Extract<Awaited<ReturnType<typeof setup.lookupPairing>>, { ok: true }>;

export function VaultPairPage({
  state,
  navigate = (url: string) => window.location.assign(url),
}: {
  state: string;
  /** Il ritorno all'app (iniettabile per i test). */
  navigate?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const { stage } = useEntryGate();
  const [finishing, setFinishing] = useState(false);
  return (
    <EntryColumn>
      <EntryHeading title={t("vault.setup.pair.title")} lead={t("vault.setup.pair.intro")} />
      {!STATE_RE.test(state) ? (
        <p role="alert" className="text-md text-ink">
          {t("vault.setup.pair.invalid")}
        </p>
      ) : stage !== "in" || finishing ? (
        <>
          <p className="mb-4 text-sm text-ink-muted">{t("vault.setup.pair.signInFirst")}</p>
          <LoginSteps onFinishing={setFinishing} onDone={() => setFinishing(false)} />
        </>
      ) : (
        <Pair state={state} navigate={navigate} />
      )}
      <ReauthHost />
    </EntryColumn>
  );
}

function Pair({ state, navigate }: { state: string; navigate: (url: string) => void }) {
  const { t, i18n } = useTranslation();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const back = `stubwise://vault?state=${encodeURIComponent(state)}`;

  useEffect(() => {
    let alive = true;
    setPairing(null);
    setLookupError(null);
    void setup.lookupPairing(state).then((out) => {
      if (!alive) return;
      if (out.ok) setPairing(out);
      else setLookupError(out.code);
    });
    return () => {
      alive = false;
    };
  }, [state]);

  async function pair() {
    setWorking(true);
    setError(null);
    const out = await setup.sealPairing(state, typed);
    setWorking(false);
    if (!out.ok) return setError(out.code);
    setDone(true);
    navigate(back);
  }

  if (lookupError) {
    const invalid = lookupError === "pairing_invalid" || lookupError === "not_found" || lookupError === "http_404";
    return (
      <p role="alert" className="text-md text-ink">
        {invalid ? t("vault.setup.pair.invalid") : t(setupErrorKey(lookupError))}
      </p>
    );
  }
  if (!pairing) return <p className="text-md text-ink-muted">{t("vault.setup.pair.loading")}</p>;
  if (done)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-md text-ink">{t("vault.setup.pair.done")}</p>
        <a href={back} className={`${primaryButton} self-start`}>
          {t("vault.setup.pair.back")}
        </a>
      </div>
    );

  const ready = typed.replace(/\s/g, "").length === 4;
  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-md font-medium text-ink">
        {t("vault.setup.pair.warning")}
      </p>
      <dl className="flex flex-col gap-1 text-md">
        <dt className="text-sm text-ink-muted">{t("vault.setup.pair.device")}</dt>
        <dd className="font-medium text-ink">{pairing.deviceName}</dd>
        {pairing.patCreatedAt && (
          <dd className="text-sm text-ink-muted">
            {pairing.patLastUsedAt
              ? t("vault.setup.pair.login", {
                  created: formatDateTime(pairing.patCreatedAt, i18n.language),
                  used: formatDateTime(pairing.patLastUsedAt, i18n.language),
                })
              : t("vault.setup.pair.loginNever", { created: formatDateTime(pairing.patCreatedAt, i18n.language) })}
          </dd>
        )}
      </dl>
      {/* M3: l'impronta NON si mostra qui. Si legge sul Mac e si scrive; il
          worker la calcola dalla pubblica del server e confronta. */}
      <EntryField
        label={t("vault.setup.pair.confirmLabel")}
        hint={t("vault.setup.pair.fingerprintHint")}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        maxLength={8}
        autoComplete="off"
        spellCheck={false}
        className="num w-32 font-mono"
      />
      {error && <ErrorLine>{t(setupErrorKey(error))}</ErrorLine>}
      <button
        type="button"
        className={`${primaryButton} self-start disabled:opacity-40`}
        disabled={!ready || working}
        onClick={() => void pair()}
      >
        <BusyLabel busy={working} idle={t("vault.setup.pair.action")} pending={t("vault.setup.pair.working")} />
      </button>
    </div>
  );
}
