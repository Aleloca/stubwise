import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultStatusQueryOptions } from "../../lib/queries";
import { addPasskeySeal, hasLiveKey } from "../../lib/vault/unlock";
import { actionButtonClass } from "../backlog/modal";
import { vaultErrorMessage } from "./unlock-dialog";

/**
 * «Aggiungi questa passkey alla cassaforte» (Impostazioni → Sicurezza,
 * accanto a ogni passkey): compare solo se la cassaforte è attiva, la
 * persona ha una chiave viva che almeno un'altra passkey apre, e QUESTA non
 * ha ancora un sigillo. Due tocchi: prima una passkey che apre già la
 * chiave, poi questa (vedi `addPasskeySeal`). Non serve la cassaforte
 * aperta, e non la apre.
 */
export function PasskeySealButton({ passkeyId, passkeyName }: { passkeyId: string; passkeyName: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({ ...vaultStatusQueryOptions, retry: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.activated || !hasLiveKey(status)) return null;
  const sealed = (status.seals ?? []).map((s) => s.passkeyId);
  if (sealed.length === 0 || sealed.includes(passkeyId)) return null;

  async function handleAdd() {
    setError(null);
    setPending(true);
    try {
      const fresh = await queryClient.fetchQuery({ ...vaultStatusQueryOptions, staleTime: 0 });
      await addPasskeySeal(fresh, passkeyId);
    } catch (cause) {
      setError(vaultErrorMessage(cause, t));
    } finally {
      setPending(false);
      await queryClient.invalidateQueries({ queryKey: vaultStatusQueryOptions.queryKey });
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[12px] text-fg-muted">{t("vault:seal.hint")}</p>
      <button
        type="button"
        aria-label={t("vault:seal.aria", { name: passkeyName })}
        onClick={() => void handleAdd()}
        disabled={pending}
        className={`${actionButtonClass} self-start`}
      >
        {pending ? t("vault:seal.pending") : t("vault:seal.action")}
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
