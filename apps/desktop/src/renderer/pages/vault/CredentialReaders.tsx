import { useState } from "react";
import { isTouchCancelled, useVaultUsable } from "./useVaultUsable";
import { useTranslation } from "react-i18next";
import { useReaders, useRemoveReader, useShare, useShareTargets } from "../../data/queries";
import type { CredentialView, ReadersView } from "../../data/vault/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton, secondaryButton } from "../tasks/controls";

// I lettori nel dettaglio di una credenziale (shape `vault.md` §3
// «Readers»): chi la legge, con la fonte («role Developer», «full admin»,
// «created it») e il perché di chi aspetta; chi è aggiunto direttamente, con
// «Remove» (conferma a due tempi in posto, poi la frase del web che resta, e
// «Change the password»); «Share with» persone e ruoli del progetto. Share e
// Remove vogliono la cassaforte aperta (la prova e le copie le fa il livello
// dati): a chiusa aprono col Touch ID, poi fanno l'azione.

type Direct = ReadersView["direct"][number];

export function CredentialReaders({
  view,
  onChangePassword,
}: {
  view: CredentialView;
  /** Dopo un «Remove»: il modulo di modifica (solo con `canEdit`). */
  onChangePassword?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const readers = useReaders(view.id).data;
  const canShare = readers?.canShare === true;
  // `canShare` dal server vuole già che chi guarda la legga (punto 3).
  const targets = useShareTargets(view.id, canShare).data;
  const share = useShare();
  const remove = useRemoveReader();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Direct | null>(null);
  const [choice, setChoice] = useState("");

  // Review M7: l'azione fa il suo Touch ID (nel main), niente apertura prima.
  const gate = useVaultUsable();
  const directName = (d: Direct) =>
    d.kind === "role" ? t("vault.readers.rolePrefix", { name: d.name }) : d.name;

  const onRemove = async (d: Direct) => {
    setConfirming(null);
    const out = await remove.mutateAsync({ id: view.id, readerId: d.readerId }).catch(() => null);
    if (isTouchCancelled(out)) return;
    if (out?.ok) setRemoved(d);
    else toast.error(t("vault.readers.failed"));
  };

  const onShare = async () => {
    const [kind, id] = choice.split(":");
    if (!kind || !id) return;
    const target = kind === "role" ? { roleId: id } : { personId: id };
    const name =
      kind === "role"
        ? t("vault.readers.rolePrefix", {
            name: targets?.roles.find((r) => r.roleId === id)?.name ?? id,
          })
        : (targets?.people.find((p) => p.personId === id)?.name ?? id);
    const out = await share.mutateAsync({ id: view.id, target }).catch(() => null);
    if (isTouchCancelled(out)) return;
    if (!out?.ok) return void toast.error(t("vault.readers.failed"));
    setChoice("");
    if (out.waiting.length > 0)
      toast.show(t("vault.readers.waiting", { emails: out.waiting.join(", ") }));
    else toast.show(t("vault.readers.shared", { name }));
  };

  if (!readers) return null;
  return (
    <section className="flex flex-col gap-3 border-t border-rule pt-4">
      <h3 className="text-md font-semibold text-ink">{t("vault.readers.title")}</h3>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-ink-muted">{t("vault.readers.who")}</span>
        <ul aria-label={t("vault.readers.who")} className="flex flex-col">
          {readers.effective.map((r) => (
            <li key={r.personId} className="flex items-baseline gap-2 py-1 text-sm">
              <span className="text-ink">{r.name}</span>
              <span className="text-ink-muted">
                {r.source === "role" && !r.roleName
                  ? t("vault.readers.source.roleUnknown")
                  : t(`vault.readers.source.${r.source}`, { role: r.roleName ?? "" })}
                {r.state !== "reads" && ` · ${t(`vault.readers.state.${r.state}`)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-ink-muted">{t("vault.readers.direct")}</span>
        {readers.direct.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("vault.readers.none")}</p>
        ) : (
          <ul aria-label={t("vault.readers.direct")} className="flex flex-col">
            {readers.direct.map((d) => (
              <li key={d.readerId} className="flex min-h-8 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{directName(d)}</span>
                {canShare &&
                  (confirming === d.readerId ? (
                    <>
                      <button
                        type="button"
                        className={quietButton}
                        onClick={() => void onRemove(d)}
                      >
                        {t("vault.readers.confirmRemove")}
                      </button>
                      <button
                        type="button"
                        className={quietButton}
                        onClick={() => setConfirming(null)}
                      >
                        {t("vault.readers.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={quietButton}
                      disabled={!gate.usable}
                      title={gate.title}
                      onClick={() => setConfirming(d.readerId)}
                    >
                      {t("vault.readers.remove")}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      {removed && (
        <div role="status" className="flex flex-col items-start gap-2 text-sm text-ink">
          <p>
            {removed.kind === "role"
              ? t("vault.readers.removedRole", { name: removed.name })
              : t("vault.readers.removedPerson", { name: removed.name })}
          </p>
          {onChangePassword && (
            <button type="button" className={secondaryButton} onClick={onChangePassword}>
              {t("vault.readers.changePassword")}
            </button>
          )}
        </div>
      )}

      {/* Review I4: condividere ricifra la PROPRIA copia della chiave: chi
          gestisce senza leggerla non ce l'ha, e lo si dice. */}
      {/* Gestisce (ha il permesso) ma non legge: condivide chi legge. */}
      {view.access === "manages" && (
        <p className="text-sm text-ink-muted">{t("vault.readers.shareNeedsRead")}</p>
      )}
      {canShare && targets && (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink-muted">
            {t("vault.readers.shareWith")}
            <select
              className={inputClass}
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">{t("vault.readers.choose")}</option>
              {targets.people.length > 0 && (
                <optgroup label={t("vault.readers.people")}>
                  {targets.people.map((p) => (
                    <option key={p.personId} value={`person:${p.personId}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {targets.roles.length > 0 && (
                <optgroup label={t("vault.readers.roles")}>
                  {targets.roles.map((r) => (
                    <option key={r.roleId} value={`role:${r.roleId}`}>
                      {t("vault.readers.rolePrefix", { name: r.name })}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <button
            type="button"
            className={secondaryButton}
            disabled={choice === "" || share.isPending || !gate.usable}
            title={gate.title}
            onClick={() => void onShare()}
          >
            {t("vault.readers.share")}
          </button>
        </div>
      )}
    </section>
  );
}
