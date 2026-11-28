import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "./api";
import { BusyLabel, ErrorLine, Heading, errorKey, formatDateTime, inputClass, primaryButton } from "./ui";

// `#/pair?state=…` della pagina a sé (design della cassaforte dal desktop
// §6.2 e §7; cassaforte nel browser §10, I7): sigilla la propria chiave per
// il Mac che ha chiesto l'associazione. Il worker legge l'associazione e ne
// calcola l'impronta, che qui NON si mostra (M3: si legge sul Mac e si
// scrive); poi la passkey, e il ritorno all'app con `stubwise://vault`.

const STATE_RE = /^[A-Za-z0-9_-]{1,200}$/;

type Pairing = Extract<Awaited<ReturnType<typeof api.lookupPairing>>, { ok: true }>;

export function PairPage({ state, navigate }: { state: string; navigate: (url: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Heading title={t("vault.setup.pair.title")} lead={t("vault.setup.pair.intro")} />
      {STATE_RE.test(state) ? (
        <Pair state={state} navigate={navigate} />
      ) : (
        <p role="alert" className="text-md text-ink">
          {t("vault.setup.pair.invalid")}
        </p>
      )}
    </>
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
    void api.lookupPairing(state).then((out) => {
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
    const out = await api.sealPairing(state, typed);
    setWorking(false);
    if (!out.ok) return setError(out.code);
    setDone(true);
    navigate(back);
  }

  if (lookupError) {
    const invalid = lookupError === "pairing_invalid" || lookupError === "not_found" || lookupError === "http_404";
    return (
      <p role="alert" className="text-md text-ink">
        {invalid ? t("vault.setup.pair.invalid") : t(errorKey(lookupError))}
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
      {/* M3: l'impronta NON si mostra qui; la confronta il worker. */}
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        {t("vault.setup.pair.confirmLabel")}
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={8}
          autoComplete="off"
          spellCheck={false}
          translate="no"
          data-gramm="false"
          className={`${inputClass} num h-9 w-32 font-mono`}
        />
        <span className="text-xs font-normal text-ink-muted">{t("vault.setup.pair.fingerprintHint")}</span>
      </label>
      {error && <ErrorLine>{t(errorKey(error))}</ErrorLine>}
      <button type="button" className={`${primaryButton} self-start`} disabled={!ready || working} onClick={() => void pair()}>
        <BusyLabel busy={working} idle={t("vault.setup.pair.action")} pending={t("vault.setup.pair.working")} />
      </button>
    </div>
  );
}
