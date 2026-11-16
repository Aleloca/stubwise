import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRegenerateIdentitySecret, type SupportWidgetView } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { formatDate } from "../../notifications/time";
import { Dialog } from "../../tasks-ui/Dialog";
import { copyText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { SecretOnce } from "../preferences/SecretOnce";
import { dangerSolidButton, secondaryButton } from "../tasks/controls";

// «Customer identity» di un widget (API per i siti, S6; piano
// 2026-11-15-integrazione-area8-api-siti, S1): il segreto con cui il backend
// del sito firma i token d'identità dei suoi clienti. Si genera e si rigenera
// con la riconferma, si mostra UNA volta (il valore vive solo nello stato del
// dialogo, «Done» lo butta), e rigenerarlo spegne il vecchio subito. Le
// letture dicono solo se c'è e da quando.

export function WidgetIdentity({ widget }: { widget: SupportWidgetView }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const set = widget.identitySecretSet;
  const toast = useToast();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col items-start gap-2 border-t border-rule pt-4"
    >
      <h3 id={`${id}-title`} className="heading-group">
        {t("support.widgets.identity.title")}
      </h3>
      <p className="text-sm text-ink-muted">{t("support.widgets.identity.about")}</p>
      <p className="text-sm text-ink">
        {set && widget.identitySecretRotatedAt
          ? t("support.widgets.identity.madeOn", {
              date: formatDate(widget.identitySecretRotatedAt, i18n.language),
            })
          : t("support.widgets.identity.none")}
      </p>
      {/* L'id del widget è il claim `aud` del token: chi lo firma lo vuole accanto al segreto. */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <span className="text-ink-muted">{t("support.widgets.identity.widgetId")}</span>
        <code className="font-code [overflow-wrap:anywhere]">{widget.id}</code>
        <button
          type="button"
          className={secondaryButton}
          aria-label={t("support.widgets.identity.copyWidgetId")}
          onClick={() =>
            void copyText(widget.id).then(
              () => toast.show(t("support.widgets.copied")),
              () => toast.error(t("support.widgets.copyError")),
            )
          }
        >
          {t("support.widgets.identity.copy")}
        </button>
      </div>
      <button ref={opener} type="button" className={secondaryButton} onClick={() => setOpen(true)}>
        {set ? t("support.widgets.identity.regenerate") : t("support.widgets.identity.make")}
      </button>
      {open && (
        <IdentitySecretDialog
          widget={widget}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function IdentitySecretDialog({
  widget,
  onClose,
}: {
  widget: SupportWidgetView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const regenerate = useRegenerateIdentitySecret();
  const [busy, setBusy] = useState(false);
  // Mentre il segreto si crea il dialogo non si chiude (review S6): il
  // vecchio è già spento, e chiudere ora perderebbe il nuovo per sempre.
  const busyRef = useRef(false);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  // Il valore vive solo qui: «Done» chiude il dialogo e lo butta.
  const [secret, setSecret] = useState<string | null>(null);
  const name = widget.name;
  const replacing = widget.identitySecretSet;

  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await reauth(() => regenerate.mutateAsync(widget.id), {
        action: t("support.widgets.identity.reauthAction", { name }),
      });
      if (r.ok) setSecret(r.secret);
      // Chiuso il dialogo della riconferma lo dice lui; ogni altro rifiuto qui.
      else if (r.error !== "reauth_cancelled") toast.error(t("support.widgets.identity.error"));
    } catch {
      toast.error(t("support.widgets.identity.error"));
    }
    busyRef.current = false;
    setBusy(false);
  }

  const lines = [
    ...(replacing ? [t("support.widgets.identity.stops")] : []),
    t("support.widgets.identity.backendOnly"),
    t("support.widgets.identity.once"),
  ];

  return (
    <Dialog
      title={
        replacing
          ? t("support.widgets.identity.dialogReplace", { name })
          : t("support.widgets.identity.dialogMake", { name })
      }
      onClose={close}
      width={480}
      footer={
        secret ? undefined : (
          <>
            <button
              type="button"
              className={secondaryButton}
              aria-disabled={busy || undefined}
              onClick={close}
            >
              {t("support.widgets.cancel")}
            </button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={dangerSolidButton}
              onClick={() => void submit()}
            >
              {replacing
                ? t("support.widgets.identity.confirmReplace")
                : t("support.widgets.identity.confirmMake")}
            </button>
          </>
        )
      }
    >
      {secret ? (
        <SecretOnce
          title={t("support.widgets.identity.secretTitle")}
          label={t("support.widgets.identity.secretLabel")}
          value={secret}
          onDone={onClose}
        />
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
