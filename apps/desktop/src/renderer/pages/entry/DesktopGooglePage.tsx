import { googleCallbackOutcomes } from "@stubwise/shared";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { secondaryButton } from "../tasks/controls";
import { EntryColumn, EntryHeading } from "./parts";

/**
 * `/app/#/desktop-google?outcome&state` (lotto 4, §6): il browser torna qui
 * dal consenso di Google quando il collegamento di una casella è partito dal
 * desktop. Dice l'esito con i testi del dialogo e riapre l'app con
 * `stubwise://google?outcome=…&state=…`: SOLO quei due parametri, e solo se
 * validi. Nessuna chiamata, nessuna sessione richiesta: l'esito non è
 * un'autorità, l'app lo conferma rileggendo le caselle.
 */
export interface DesktopGoogleParams {
  outcome?: string;
  state?: string;
}

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OUTCOMES: ReadonlySet<string> = new Set(googleCallbackOutcomes);

/** L'esito del server nelle parole del dialogo (`prefs.google.dialog.errors.*`). */
const ERROR_KEY: Readonly<Record<string, string>> = {
  domain_mismatch: "wrong_domain",
  insufficient_scope: "scopes_missing",
  mailbox_owned_by_other: "owned_by_other",
};

function valid(p: DesktopGoogleParams): p is Required<DesktopGoogleParams> {
  return (
    typeof p.outcome === "string" &&
    OUTCOMES.has(p.outcome) &&
    typeof p.state === "string" &&
    STATE_RE.test(p.state)
  );
}

const returnUrl = (p: Required<DesktopGoogleParams>) =>
  `stubwise://google?outcome=${encodeURIComponent(p.outcome)}&state=${encodeURIComponent(p.state)}`;

export function DesktopGooglePage(params: DesktopGoogleParams) {
  const { t } = useTranslation();
  const ok = valid(params);
  const url = ok ? returnUrl(params) : null;

  useEffect(() => {
    if (url) window.location.assign(url);
  }, [url]);

  if (!ok) {
    return (
      <EntryColumn>
        <EntryHeading
          title={t("entry.desktopGoogle.invalid.title")}
          lead={t("entry.desktopGoogle.invalid.lead")}
        />
      </EntryColumn>
    );
  }
  const connected = params.outcome === "ok";
  return (
    <EntryColumn>
      {/* Revisione del lotto 4, M-2: un `ok` si può forgiare; non si dice «collegata»,
          lo conferma l'app rileggendo le caselle. */}
      <EntryHeading
        title={t(connected ? "entry.desktopGoogle.backToApp" : "entry.desktopGoogle.notConnected")}
        lead={
          connected
            ? undefined
            : t(`prefs.google.dialog.errors.${ERROR_KEY[params.outcome] ?? "failed"}`)
        }
      />
      <button
        type="button"
        className={secondaryButton}
        onClick={() => window.location.assign(url!)}
      >
        {t("entry.desktopGoogle.open")}
      </button>
    </EntryColumn>
  );
}
