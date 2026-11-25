import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isAppBuild } from "../../data/build";
import { useMacsOf, useRemoveMacOf } from "../../data/queries";
import type { MacView } from "../../data/vault/types";
import { useReauth } from "../../layout/useReauth";
import { openInWeb } from "../../platform/openWeb";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { Part } from "../preferences/parts";
import { dangerSolidButton, quietButton } from "../tasks/controls";

// Amministrazione → una persona, la parte «Vault» (D-6, shape `vault.md` §3,
// sotto «Linked identities»): solo per un full admin (il livello dati
// risponde `forbidden` agli altri, e la parte non c'è). I Mac della persona
// che aprono la cassaforte, senza impronta, e «Remove…» per riga: un dialogo
// con le conseguenze, una per riga, poi la riconferma. Dal desktop vero la
// rotta dell'admin è del browser [VA 9]: «Remove…» apre la pagina lì.

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function VaultAdminPart({ personId, name }: { personId: string; name: string }) {
  const { t } = useTranslation();
  const macs = useMacsOf(personId).data;
  const [removing, setRemoving] = useState<MacView | null>(null);
  if (!macs || !macs.ok) return null;
  const onRemove = (mac: MacView) => {
    if (isAppBuild()) return openInWeb(`/admin/people/${encodeURIComponent(personId)}`);
    setRemoving(mac);
  };
  return (
    <Part title={t("vault.admin.title")}>
      <p className="text-md text-ink-muted">{t("vault.admin.intro", { name })}</p>
      {macs.macs.length === 0 ? (
        <p className="mt-3 text-md text-ink-muted">{t("vault.admin.empty", { name })}</p>
      ) : (
        <ul className="mt-3 flex flex-col border-t border-rule">
          {macs.macs.map((mac) => (
            <li
              key={mac.id}
              className="flex min-h-10 items-center gap-3 border-b border-rule py-1.5"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md text-ink">{mac.name}</span>
                <span className="text-sm text-ink-muted">
                  {mac.lastUsedAt
                    ? t("vault.macs.paired", {
                        paired: day(mac.pairedAt),
                        used: day(mac.lastUsedAt),
                      })
                    : t("vault.macs.pairedNever", { paired: day(mac.pairedAt) })}
                </span>
              </div>
              <button
                type="button"
                className={quietButton}
                aria-label={t("vault.admin.removeAria", { mac: mac.name })}
                onClick={() => onRemove(mac)}
              >
                {t("vault.admin.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <RemoveMacDialog
          personId={personId}
          name={name}
          mac={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </Part>
  );
}

function RemoveMacDialog({
  personId,
  name,
  mac,
  onClose,
}: {
  personId: string;
  name: string;
  mac: MacView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useRemoveMacOf();
  const confirm = async () => {
    const out = await reauth(
      async () => {
        const r = await remove.mutateAsync({ personId, macId: mac.id });
        // La cassaforte dice `code`; la riconferma riconosce `error`.
        return !r.ok && r.code === "reauth_required"
          ? ({ ok: false, error: "reauth_required" } as const)
          : r;
      },
      { action: t("vault.admin.reauth") },
    ).catch(() => null);
    if (out && "error" in out && out.error === "reauth_cancelled") return;
    if (!out?.ok) return void toast.error(t("vault.admin.failed"));
    toast.show(t("vault.admin.removed", { name }));
    onClose();
  };
  return (
    <Dialog
      title={t("vault.admin.dialogTitle", { name, mac: mac.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={quietButton} onClick={onClose}>
            {t("vault.admin.cancel")}
          </button>
          <button type="button" className={dangerSolidButton} onClick={() => void confirm()}>
            {t("vault.admin.confirm")}
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-1 text-md text-ink">
        <li>{t("vault.admin.stops")}</li>
        <li>{t("vault.admin.staysSignedIn", { name })}</li>
        <li>{t("vault.admin.alerted", { name })}</li>
      </ul>
    </Dialog>
  );
}
