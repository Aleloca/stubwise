import { useTranslation } from "react-i18next";
import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { Dialog } from "../../tasks-ui/Dialog";
import { PrototypeBox } from "../automations/shared";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { shortInput } from "./Part";

// I dialoghi della parte «SSH access» (shape server-access.md §3, Rigenera
// e Revoca, 440px) e il riquadro «Prototype only» della verifica.

/**
 * «Regenerate SRV-1's keys?». `body` lo sceglie la parte accesso per
 * accesso da `usable` (R-L8: una chiave attuale resta valida fino alla
 * verifica delle nuove solo se funziona già).
 */
export function RegenerateDialog({
  code,
  body,
  pending,
  onConfirm,
  onClose,
}: {
  code: string;
  body: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("servers.ssh.regenerate.title", { code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.ssh.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={pending}
            onClick={onConfirm}
          >
            {t("servers.ssh.regenerate.confirm")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{body}</p>
    </Dialog>
  );
}

/** «Revoke SSH access to SRV-1?»: le conseguenze, una per riga, poi il rosso pieno. */
export function RevokeDialog({
  code,
  pending,
  onConfirm,
  onClose,
}: {
  code: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("servers.ssh.revoke.title", { code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.ssh.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={pending}
            onClick={onConfirm}
          >
            {t("servers.ssh.revoke.confirm")}
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-1.5 text-md text-ink">
        {(["noLook", "fixStops", "planBlocked", "forget"] as const).map((k) => (
          <li key={k} className="flex gap-2">
            <span aria-hidden="true" className="text-ink-faint">
              –
            </span>
            <span>{t(`servers.ssh.revoke.${k}`, { code })}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

const OUTCOMES: readonly VerifyOutcome[] = [
  "ok",
  "read_fails",
  "fix_fails",
  "read_writes",
  "unreachable",
];

/**
 * SOLO PROTOTIPO: l'esito della prossima «Verify», sotto la parte e solo a
 * chi gestisce gli accessi (è l'unico che può verificare). Non tocca server.
 */
export function SshSimulateBox({
  value,
  onChange,
}: {
  value: VerifyOutcome;
  onChange: (outcome: VerifyOutcome) => void;
}) {
  const { t } = useTranslation();
  return (
    <PrototypeBox label={t("servers.ssh.simulate.label")}>
      <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
        {t("servers.ssh.simulate.next")}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as VerifyOutcome)}
          className={`${shortInput} h-7 py-0 text-sm`}
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`servers.ssh.simulate.outcomes.${o}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-ink-muted">{t("servers.ssh.simulate.hint")}</p>
    </PrototypeBox>
  );
}
