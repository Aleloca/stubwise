import { appPath, vaultPagePath } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PairingDialog } from "./PairingDialog";
import { VaultPrototype } from "./VaultPrototype";
import { isAppBuild } from "../../data/build";
import { useVaultLock, useVaultStatus, useVaultUnlock } from "../../data/queries";
import type { VaultStatusView } from "../../data/vault/types";
import { useViewer } from "../../data/viewing";
import { openInWeb } from "../../platform/openWeb";
import { isWebAppBuild } from "../../platform/vaultBridge";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";

// La barra della cassaforte (shape `vault.md` §3): una riga in testa alla
// sezione Credentials e alla pagina Vault, uno stato alla volta, l'azione a
// destra. Senza Touch ID (D-1a) la cassaforte si apre nel browser; un
// sigillo revocato lascia il login (D-5). Un tocco annullato non dice
// niente: annullare è una scelta.

const ROW =
  "flex min-h-11 items-center gap-3 rounded-md border border-rule bg-ink/3 px-4 py-2 text-md text-ink";

/** Apre la cassaforte; un esito che non sia un annullamento si dice. */
export function useOpenVault() {
  const { t } = useTranslation();
  const toast = useToast();
  const unlock = useVaultUnlock();
  const open = async (): Promise<boolean> => {
    const out = await unlock.mutateAsync(undefined).catch(() => null);
    if (out?.ok) return true;
    // La barra dice già revocata, irraggiungibile o senza Touch ID; annullato è una scelta.
    // Nel browser: la passkey annullata è una scelta, e una senza PRF la dice la barra.
    const quiet = [
      "touch_id_cancelled",
      "touch_id_unavailable",
      "revoked",
      "unavailable",
      "unpaired",
      "passkey_failed",
      "passkey_unsupported",
    ];
    if (!out || !quiet.includes(out.code))
      toast.error(t(isWebAppBuild() ? "vault.bar.openFailedWeb" : "vault.bar.openFailed"));
    return false;
  };
  return { open, pending: unlock.isPending };
}

/**
 * Il browser con la passkey (D-1a): nell'app lo apre il main, sulla
 * cassaforte della nuova app nel browser (non più `/credentials` del web
 * vecchio); il prototipo lo dice e basta. L'indirizzo dall'helper dei link.
 */
export function openVaultInBrowser(): void {
  if (isAppBuild()) openInWeb(appPath({ to: "vault" }));
}

/**
 * La pagina A SÉ della cassaforte (fase 2, design §10; revisione I-2):
 * attivarla, creare la propria chiave. Un documento suo, con la sua CSP: ci
 * si entra SEMPRE con una navigazione completa, mai cambiando il frammento.
 * Dal Mac si apre nel browser.
 */
export function openVaultSetup(): void {
  if (isWebAppBuild()) window.location.assign(vaultPagePath("setup"));
  else if (isAppBuild()) openInWeb(vaultPagePath("setup"));
}

export function VaultBar({ onPair: onPairProp }: { onPair?: () => void }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const fullAdmin = viewer.instancePermissions.includes("instance.full_admin");
  // «Pair this Mac» apre la finestra dell'associazione (shape §3, [VA 8]).
  const [pairing, setPairing] = useState(false);
  const onPair = onPairProp ?? (() => setPairing(true));
  const toast = useToast();
  const status = useVaultStatus();
  const { open, pending } = useOpenVault();
  const lock = useVaultLock();

  if (status.isError) {
    return (
      <div role="alert" className={ROW}>
        <span className="flex-1">{t("vault.errors.status")}</span>
        <button type="button" className={secondaryButton} onClick={() => void status.refetch()}>
          {t("vault.bar.retry")}
        </button>
      </div>
    );
  }
  const s: VaultStatusView | undefined = status.data;
  if (!s) {
    return (
      <div aria-busy="true" className={ROW} data-vault-bar="checking">
        <span className="text-ink-muted">{t("vault.bar.checking")}</span>
      </div>
    );
  }

  const browser = (
    <button
      type="button"
      className={secondaryButton}
      onClick={() => {
        openVaultInBrowser();
        toast.show(t("vault.bar.openedBrowser"));
      }}
    >
      {t("vault.bar.openBrowser")}
    </button>
  );

  let glyph = "○";
  let text: React.ReactNode = null;
  let action: React.ReactNode = null;
  switch (s.state) {
    case "open":
      glyph = "●";
      text = (
        <span className="flex flex-col">
          <span>{t(isWebAppBuild() ? "vault.bar.openWeb" : "vault.bar.open")}</span>
          <span className="text-sm text-ink-muted">{t("vault.bar.recorded")}</span>
          {/* Design §7: nel browser lo stop e il blocco dello schermo chiudono solo al ritorno. */}
          {isWebAppBuild() && <span className="text-sm text-ink-muted">{t("vault.bar.webLimit")}</span>}
        </span>
      );
      action = (
        <button type="button" className={secondaryButton} onClick={() => lock.mutate(undefined)}>
          {t("vault.bar.lock")}
        </button>
      );
      break;
    case "passkey_unsupported":
      // Cassaforte nel browser (§9): la passkey usata non dà la PRF.
      text = t("vault.bar.passkeyUnsupported");
      action = (
        <button type="button" className={secondaryButton} disabled={pending} onClick={() => void open()}>
          {t("vault.bar.tryAnotherPasskey")}
        </button>
      );
      break;
    case "locked":
      if (isWebAppBuild()) {
        // Cassaforte nel browser (§9): si apre con la passkey, nella scheda.
        text = t("vault.bar.locked");
        action = (
          <button type="button" className={primaryButton} disabled={pending} onClick={() => void open()}>
            {pending ? t("vault.bar.opening") : t("vault.bar.openPasskey")}
          </button>
        );
        break;
      }
      text = s.touchId ? t("vault.bar.locked") : t("vault.bar.noTouchId");
      action = s.touchId ? (
        <button
          type="button"
          className={primaryButton}
          disabled={pending}
          onClick={() => void open()}
        >
          {pending ? t("vault.bar.opening") : t("vault.bar.openTouch")}
        </button>
      ) : (
        browser
      );
      break;
    case "unpaired":
      text = t("vault.bar.unpaired");
      action = onPair ? (
        <button type="button" className={primaryButton} onClick={onPair}>
          {t("vault.bar.pair")}
        </button>
      ) : null;
      break;
    case "revoked":
      glyph = "▲";
      text = t("vault.bar.revoked");
      action = onPair ? (
        <button type="button" className={secondaryButton} onClick={onPair}>
          {t("vault.bar.pairAgain")}
        </button>
      ) : null;
      break;
    // Due stati che produce solo il main dell'app: la cassaforte si apre dal browser.
    case "disabled":
      text = t("vault.bar.disabled");
      action = browser;
      break;
    case "unsupported":
      // Review M10: nella build web non è «questo Mac», è il browser.
      if (isWebAppBuild()) {
        text = t("vault.bar.unsupportedWeb");
        action = (
          <button type="button" className={secondaryButton} onClick={openVaultInBrowser}>
            {t("vault.bar.openWebPage")}
          </button>
        );
      } else {
        text = t("vault.bar.unsupported");
        action = browser;
      }
      break;
    case "unreachable":
      glyph = "▲";
      text = t("vault.bar.unreachable");
      action = (
        <button
          type="button"
          className={secondaryButton}
          disabled={pending}
          onClick={() => void open()}
        >
          {t("vault.bar.retry")}
        </button>
      );
      break;
    case "no_key":
      text = t("vault.bar.noKey");
      // Fase 2: la chiave si crea nella pagina della cassaforte, nel browser.
      action = (
        <button
          type="button"
          className={isWebAppBuild() ? primaryButton : secondaryButton}
          onClick={() => {
            openVaultSetup();
            if (!isWebAppBuild()) toast.show(t("vault.bar.openedBrowser"));
          }}
        >
          {isWebAppBuild() ? t("vault.bar.createKey") : t("vault.bar.openBrowser")}
        </button>
      );
      break;
    case "key_pending":
      text = (
        <span className="flex flex-col gap-0.5">
          <span>{t("vault.bar.keyPending")}</span>
          {s.ownFingerprint && (
            <span className="text-sm text-ink-muted">
              {t("vault.bar.ownFingerprint")}{" "}
              <span className="num font-mono text-ink">{s.ownFingerprint}</span>
            </span>
          )}
        </span>
      );
      break;
    case "inactive":
      // Review M2: all'admin la shape dice dove attivarla.
      text = (
        <span className="flex flex-col">
          <span>{t("vault.bar.inactive")}</span>
          {fullAdmin && !isWebAppBuild() && <span>{t("vault.bar.inactiveAdmin")}</span>}
        </span>
      );
      // Fase 2: l'admin la attiva nella pagina della cassaforte (nel browser).
      if (fullAdmin && isAppBuild())
        action = (
          <button
            type="button"
            className={isWebAppBuild() ? primaryButton : secondaryButton}
            onClick={() => {
              openVaultSetup();
              if (!isWebAppBuild()) toast.show(t("vault.bar.openedBrowser"));
            }}
          >
            {isWebAppBuild() ? t("vault.bar.activateWeb") : t("vault.bar.openBrowser")}
          </button>
        );
      break;
  }

  return (
    <>
      {pairing && <PairingDialog onClose={() => setPairing(false)} />}
      <div className={ROW} data-vault-bar={s.state}>
        <span
          aria-hidden="true"
          className={
            glyph === "●" ? "text-positive" : glyph === "▲" ? "text-warning" : "text-ink-muted"
          }
        >
          {glyph}
        </span>
        <span className="min-w-0 flex-1">{text}</span>
        {action && <span className="shrink-0">{action}</span>}
      </div>
      {/* Solo nel prototipo: cosa succede al prossimo Touch ID e alla prossima apertura. */}
      {!isAppBuild() && <VaultPrototype />}
    </>
  );
}
