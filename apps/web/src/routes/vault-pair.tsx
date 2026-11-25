import { keyFingerprint } from "@stubwise/vault-crypto";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { actionPrimaryClass } from "../components/backlog/modal";
import { vaultErrorMessage } from "../components/vault/unlock-dialog";
import { ApiError, getVaultStatus, postVaultDevicePairingLookup } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { proveKey } from "../lib/vault/credentials";
import { sealForMac } from "../lib/vault/unlock";

/**
 * Lotto 10, la chiave del Mac (design `2026-11-24-cassaforte-desktop-design.md`
 * §6.2 e §7; revisione di sicurezza I2): la pagina del browser che sigilla la
 * propria chiave di persona per il Mac che ha chiesto l'associazione. Il Mac
 * apre `/vault-pair?state=…`; pubblica e nome del Mac si leggono dal server
 * per quello state (mai dall'indirizzo, che si inoltra). Prima di sigillare
 * la persona legge l'avviso («solo se l'hai avviato tu ora»), riconosce il
 * login del Mac (creato, ultimo uso), confronta l'impronta INTERA e la
 * conferma attivamente scrivendo gli ultimi 4 caratteri. Poi una cerimonia
 * della passkey con la PRF, il sigillo, e il ritorno all'app
 * (`stubwise://vault?state=…`).
 */
export function VaultPairPage({
  state,
  navigate = (url: string) => window.location.assign(url),
}: {
  state: string;
  /** Il ritorno all'app (iniettabile per i test). */
  navigate?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const pairing = useQuery({
    queryKey: ["vault", "device-pairing", state],
    queryFn: () => postVaultDevicePairingLookup(state),
    retry: false,
    staleTime: Infinity,
    enabled: state !== "",
  });
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const devicePublicKey = pairing.data?.devicePublicKey;

  useEffect(() => {
    let alive = true;
    setFingerprint(null);
    if (devicePublicKey)
      void keyFingerprint(devicePublicKey).then(
        (fp) => alive && setFingerprint(fp),
        () => alive && setFingerprint(null),
      );
    return () => {
      alive = false;
    };
  }, [devicePublicKey]);

  const back = `stubwise://vault?state=${encodeURIComponent(state)}`;
  const last4 = fingerprint ? fingerprint.replace(/\s/g, "").slice(-4).toLowerCase() : null;
  const confirmed = last4 !== null && typed.replace(/\s/g, "").toLowerCase() === last4;

  const pair = async () => {
    if (!pairing.data || !confirmed) return;
    setWorking(true);
    setError(null);
    try {
      const status = await getVaultStatus();
      await sealForMac(
        status,
        { state, deviceId: pairing.data.deviceId, devicePublicKey: pairing.data.devicePublicKey },
        proveKey,
      );
      setDone(true);
      navigate(back);
    } catch (cause) {
      setError(vaultErrorMessage(cause, t));
    } finally {
      setWorking(false);
    }
  };

  const invalid =
    pairing.isError &&
    pairing.error instanceof ApiError &&
    (pairing.error.status === 404 || pairing.error.code === "pairing_invalid");

  return (
    <section className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">{t("vault:pair.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("vault:pair.intro")}</p>
      </header>

      {state === "" ? (
        <p role="alert" className="text-sm">
          {t("vault:pair.invalid")}
        </p>
      ) : pairing.isPending ? (
        <p className="text-sm text-fg-muted">{t("vault:pair.loading")}</p>
      ) : pairing.isError ? (
        <p role="alert" className="text-sm">
          {invalid ? t("vault:pair.invalid") : vaultErrorMessage(pairing.error, t)}
        </p>
      ) : done ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("vault:pair.done")}</p>
          <a href={back} className={actionPrimaryClass}>
            {t("vault:pair.back")}
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p
            role="note"
            className="rounded-sm border border-signal/40 bg-signal/10 p-3 text-sm font-medium"
          >
            {t("vault:pair.warning")}
          </p>
          <dl className="flex flex-col gap-1 text-sm">
            <dt className="text-fg-muted">{t("vault:pair.device")}</dt>
            <dd className="font-medium">{pairing.data.deviceName}</dd>
            {pairing.data.patCreatedAt && (
              <dd className="text-fg-muted">
                {pairing.data.patLastUsedAt
                  ? t("vault:pair.login", {
                      created: formatDateTime(pairing.data.patCreatedAt),
                      used: formatDateTime(pairing.data.patLastUsedAt),
                    })
                  : t("vault:pair.loginNever", {
                      created: formatDateTime(pairing.data.patCreatedAt),
                    })}
              </dd>
            )}
          </dl>
          {/* M3 (seconda revisione): l'impronta NON si mostra qui. Si legge sul
              Mac e si scrive; la pagina la calcola dalla pubblica del server e
              confronta. Mostrata, la si copierebbe dalla pagina stessa. */}
          <label className="flex flex-col gap-1 text-sm">
            {t("vault:pair.confirmLabel")}
            <span className="text-xs text-fg-muted">{t("vault:pair.fingerprintHint")}</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              className="w-32 rounded-sm border border-border px-2 py-1 font-mono"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div>
            <button
              type="button"
              className={actionPrimaryClass}
              disabled={!confirmed || working}
              onClick={() => void pair()}
            >
              {working ? t("vault:pair.working") : t("vault:pair.action")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
