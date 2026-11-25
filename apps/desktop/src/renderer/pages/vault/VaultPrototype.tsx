import { useTranslation } from "react-i18next";
import { useFinishPairing, useSetVaultSimulation, useVaultSimulation } from "../../data/queries";
import type { VaultSimulation } from "../../data/vault/types";
import { PrototypeBox } from "../automations/shared";

// Il riquadro «Prototype only» della cassaforte (shape `vault.md` §3): solo
// nel prototipo, decide cosa succede al prossimo Touch ID e alla prossima
// apertura. L'esito del ritorno dal browser sta DENTRO il dialogo
// dell'associazione (`PairingPrototype`): il dialogo è modale, e un riquadro
// fuori non si potrebbe toccare (la shape lo voleva sotto la barra).

const pillClass =
  "h-7 rounded-md border border-rule px-2 text-sm text-ink-muted aria-pressed:border-ink aria-pressed:text-ink";

function Choice<K extends keyof VaultSimulation>({
  label,
  field,
  options,
}: {
  label: string;
  field: K;
  options: { value: VaultSimulation[K]; label: string }[];
}) {
  const sim = useVaultSimulation().data;
  const set = useSetVaultSimulation();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-muted">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={pillClass}
          aria-pressed={sim?.[field] === o.value}
          onClick={() => void set.mutateAsync({ [field]: o.value } as Partial<VaultSimulation>)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Sotto la barra: il prossimo Touch ID e la prossima apertura. */
export function VaultPrototype() {
  const { t } = useTranslation();
  return (
    <PrototypeBox label={t("vault.prototype.barLabel")}>
      <Choice
        label={t("vault.prototype.touch")}
        field="touchId"
        options={[
          { value: "works", label: t("vault.prototype.touchWorks") },
          { value: "cancelled", label: t("vault.prototype.touchCancelled") },
          { value: "unavailable", label: t("vault.prototype.touchUnavailable") },
        ]}
      />
      <Choice
        label={t("vault.prototype.opening")}
        field="opening"
        options={[
          { value: "works", label: t("vault.prototype.openingWorks") },
          { value: "revoked", label: t("vault.prototype.openingRevoked") },
          { value: "unreachable", label: t("vault.prototype.openingUnreachable") },
        ]}
      />
      <p className="text-xs text-ink-faint">{t("vault.prototype.note")}</p>
    </PrototypeBox>
  );
}

/** Nel dialogo dell'associazione, mentre aspetta: come torna il browser. */
export function PairingPrototype() {
  const { t } = useTranslation();
  const finish = useFinishPairing();
  return (
    <PrototypeBox label={t("vault.prototype.pairingLabel")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-muted">{t("vault.prototype.pairing")}</span>
        {(
          [
            ["ok", "pairingOk"],
            ["expired", "pairingExpired"],
            ["mismatch", "pairingMismatch"],
          ] as const
        ).map(([outcome, key]) => (
          <button
            key={outcome}
            type="button"
            className={pillClass}
            onClick={() => void finish.mutateAsync(outcome).catch(() => null)}
          >
            {t(`vault.prototype.${key}`)}
          </button>
        ))}
      </div>
    </PrototypeBox>
  );
}
