import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isAppBuild } from "../../data/build";
import { EMAIL_RE } from "../../data/me/accountRules";
import { useEmailChange, type MyProfile } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { BusyLabel, EntryField } from "../entry/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { refusalOf, rowButton } from "./parts";

// L'email di login nel profilo (area 9, R2; design integrazione area 9,
// 1.6). Si legge e non si scrive nel modulo: «Change email…» chiede il
// nuovo indirizzo e la riconferma, e il link parte verso di lui. Fino al
// clic si entra con la vecchia, e la riga lo dice; «Cancel change» la
// spegne. Senza trasporto email l'istanza non può mandare il link: lo fa un
// amministratore (People), e la riga lo dice.

export function LoginEmail({ profile }: { profile: MyProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const change = useEmailChange();
  const [open, setOpen] = useState(false);
  const pending = profile.pendingEmail ?? null;
  const available = profile.emailChangeAvailable ?? true;
  const failed = () => toast.error(t("prefs.account.email.failed"));

  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink">{t("prefs.account.email.label")}</span>
        <span data-testid="login-email" className="text-sm text-ink [overflow-wrap:anywhere]">
          {profile.email}
        </span>
        {available && !pending && (
          <button type="button" className={rowButton + " h-8"} onClick={() => setOpen(true)}>
            {t("prefs.account.email.change")}
          </button>
        )}
      </div>
      {!available && !pending && (
        <p className="text-sm text-ink-muted">{t("prefs.account.email.unavailable")}</p>
      )}
      {pending && (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm text-ink">
            {t("prefs.account.email.pending", { next: pending.email, current: profile.email })}
          </p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => change.cancel.mutate(undefined, { onError: failed })}
          >
            {t("prefs.account.email.cancel")}
          </button>
          {!isAppBuild() && (
            <PrototypeBox>
              <button
                type="button"
                className={secondaryButton}
                onClick={() =>
                  change.simulateLink.mutate(undefined, {
                    onSuccess: (r) => {
                      if (refusalOf(r)) failed();
                    },
                    onError: failed,
                  })
                }
              >
                {t("prefs.account.email.openLink")}
              </button>
            </PrototypeBox>
          )}
        </div>
      )}
      {open && <ChangeEmailDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function ChangeEmailDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const reauth = useReauth();
  const change = useEmailChange();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    if (!EMAIL_RE.test(email.trim())) return setError(t("prefs.account.profile.invalidEmail"));
    setBusy(true);
    try {
      const r = await reauth(() => change.request.mutateAsync(email.trim()), {
        action: t("prefs.account.email.reauthAction"),
      });
      if (r.ok) return onClose();
      if (r.error === "reauth_cancelled") return;
      const reason = "reason" in r ? r.reason : undefined;
      if (r.error === "email_transport_unavailable") setError(t("prefs.account.email.unavailable"));
      else if (reason === "email_taken") setError(t("prefs.account.profile.emailTaken"));
      else if (reason === "email") setError(t("prefs.account.profile.invalidEmail"));
      else setError(t("prefs.account.email.failed"));
    } catch {
      setError(t("prefs.account.email.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t("prefs.account.email.dialogTitle")}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("prefs.common.cancel")}
          </button>
          <button
            type="submit"
            form="change-email"
            className={primaryButton}
            aria-busy={busy || undefined}
          >
            <BusyLabel
              busy={busy}
              idle={t("prefs.account.email.send")}
              pending={t("prefs.account.email.sending")}
            />
          </button>
        </>
      }
    >
      <form
        id="change-email"
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
      >
        <p className="text-sm text-ink-muted">{t("prefs.account.email.dialogAbout")}</p>
        <EntryField
          label={t("prefs.account.email.newLabel")}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
          autoComplete="email"
          autoFocus
        />
      </form>
    </Dialog>
  );
}
