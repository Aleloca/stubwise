import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopHandoff, useEntryGate, usePeople } from "../../data/queries";
import { useViewer } from "../../data/viewing";
import { ReauthHost } from "../../layout/ReauthDialog";
import { useReauth } from "../../layout/useReauth";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { LoginSteps } from "./LoginPage";
import { BusyLabel, EntryColumn, EntryHeading, ErrorLine } from "./parts";

/**
 * `/app/#/desktop-login?challenge&state&device` (integrazione area 2,
 * «Aggiunta del 9 nov 2026: il login»): il browser conferma il login
 * dell'app desktop. Senza una sessione completa prima il login web; poi la
 * domanda «Allow Stubwise on "<device>" to sign in as <name>?». Il codice
 * monouso si chiede SOLO al clic su «Allow» (mai al caricamento), con la
 * riconferma se il server la vuole, e torna all'app con
 * `stubwise://auth?code=…&state=…`.
 */
export interface DesktopLoginParams {
  challenge?: string;
  state?: string;
  device?: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validParams(p: DesktopLoginParams): p is Required<DesktopLoginParams> {
  return (
    typeof p.challenge === "string" &&
    CHALLENGE_RE.test(p.challenge) &&
    typeof p.state === "string" &&
    STATE_RE.test(p.state) &&
    typeof p.device === "string" &&
    p.device.trim().length > 0 &&
    p.device.length <= 60
  );
}

export function DesktopLoginPage(params: DesktopLoginParams) {
  const { t } = useTranslation();
  const { stage } = useEntryGate();
  // Dentro, ma con un passo del login ancora da mostrare (i codici di backup quasi finiti).
  const [finishing, setFinishing] = useState(false);

  return (
    <EntryColumn>
      {!validParams(params) ? (
        <EntryHeading title={t("entry.desktopLogin.invalid.title")} lead={t("entry.desktopLogin.invalid.lead")} />
      ) : stage !== "in" || finishing ? (
        <>
          <p className="mb-4 text-sm text-ink-muted">
            {t("entry.desktopLogin.signInFirst", { device: params.device })}
          </p>
          <LoginSteps onFinishing={setFinishing} onDone={() => setFinishing(false)} />
        </>
      ) : (
        <Consent challenge={params.challenge} state={params.state} device={params.device} />
      )}
      {/* «Confirm it's you»: fuori dall'intelaiatura dell'app, si monta qui. */}
      <ReauthHost />
    </EntryColumn>
  );
}

function Consent({ challenge, state, device }: Required<DesktopLoginParams>) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const { data: people = [] } = usePeople();
  const handoff = useDesktopHandoff();
  const run = useReauth();
  const [outcome, setOutcome] = useState<"idle" | "opened" | "cancelled" | "failed" | "nothing_changed">("idle");
  const name = people.find((p) => p.id === viewer.personId)?.name ?? "";

  async function allow() {
    if (handoff.isPending) return;
    setOutcome("idle");
    const r = await run(() => handoff.mutateAsync({ codeChallenge: challenge, deviceName: device }), {
      action: t("entry.desktopLogin.reauthAction", { device }),
    });
    if (r.ok) {
      setOutcome("opened");
      window.location.assign(
        `stubwise://auth?code=${encodeURIComponent(r.code)}&state=${encodeURIComponent(state)}`,
      );
      return;
    }
    setOutcome(r.error === "reauth_cancelled" ? "nothing_changed" : "failed");
  }

  if (outcome === "opened") {
    return <EntryHeading title={t("entry.desktopLogin.opened.title")} lead={t("entry.desktopLogin.opened.lead")} />;
  }
  if (outcome === "cancelled") {
    return (
      <EntryHeading title={t("entry.desktopLogin.cancelled.title")} lead={t("entry.desktopLogin.cancelled.lead")} />
    );
  }
  return (
    <>
      <EntryHeading
        title={
          name
            ? t("entry.desktopLogin.consent.title", { device, name })
            : t("entry.desktopLogin.consent.titleNoName", { device })
        }
        lead={t("entry.desktopLogin.consent.lead")}
      />
      <div className="flex flex-col gap-4">
        {outcome === "failed" && <ErrorLine>{t("entry.desktopLogin.consent.failed")}</ErrorLine>}
        {outcome === "nothing_changed" && <ErrorLine>{t("entry.desktopLogin.consent.nothingChanged")}</ErrorLine>}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className={secondaryButton} onClick={() => setOutcome("cancelled")}>
            {t("entry.desktopLogin.consent.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            aria-busy={handoff.isPending}
            onClick={() => void allow()}
          >
            <BusyLabel
              busy={handoff.isPending}
              idle={t("entry.desktopLogin.consent.allow")}
              pending={t("entry.desktopLogin.consent.allowing")}
            />
          </button>
        </div>
      </div>
    </>
  );
}
