import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmKey, useRejectKey, useVaultPending } from "../../data/queries";
import type { PendingPersonView } from "../../data/vault/types";
import { DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { useToast } from "../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Gli accessi da confermare (shape `vault.md` §3): la riga sotto la barra
// per chi ha persone da confermare («N people are waiting for access ·
// Review»), e il pannello di destra (`?pending=1`) con una scheda per
// persona: email, data e dispositivo della chiave, l'impronta in monospace,
// quante credenziali. Confirm e Reject sono a due tempi con la domanda intera
// [VA 7] e vogliono la cassaforte aperta (Touch ID, poi l'azione). Le frasi
// non presumono il genere: dicono il nome.

const WHERE = /^\/(?:p\/[^/]+\/credentials|vault)\/?$/;

function useSetPending() {
  const navigate = useNavigate();
  return useCallback(
    (on: boolean) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          pending: on ? "1" : undefined,
          credential: undefined,
        })) as never,
      }),
    [navigate],
  );
}

/** La riga sotto la barra: solo con persone da confermare. */
export function PendingRow() {
  const { t } = useTranslation();
  const pending = useVaultPending().data;
  const setPending = useSetPending();
  if (!pending || pending.length === 0) return null;
  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-rule px-3 text-md">
      <span aria-hidden className="text-ink-muted">
        ○
      </span>
      <span className="min-w-0 flex-1 text-ink">
        {t("vault.pending.waiting", { count: pending.length })}
      </span>
      <button type="button" className={secondaryButton} onClick={() => setPending(true)}>
        {t("vault.pending.review")}
      </button>
    </div>
  );
}

/** Montato dal layout: il pannello su `?pending=1`, nella sezione Credentials o nella pagina Vault. */
export function PendingPanelHost() {
  const search = useSearch({ strict: false }) as { pending?: string };
  const here = useRouterState({ select: (s) => WHERE.test(s.location.pathname) });
  if (search.pending !== "1" || !here) return null;
  return <PendingPanel />;
}

function PendingPanel() {
  const { t } = useTranslation();
  const docked = useMediaQuery(CREDENTIAL_PANEL_DOCKED_QUERY);
  const pending = useVaultPending().data;
  const setPending = useSetPending();
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("vault.pending.title")}
      onClose={() => setPending(false)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <header className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-ink">
            {t("vault.pending.title")}
          </h2>
          <button type="button" className={quietButton} onClick={() => setPending(false)}>
            {t("vault.detail.close")}
          </button>
        </header>
        {pending && pending.length === 0 && (
          <p className="text-sm text-ink-muted">{t("vault.pending.empty")}</p>
        )}
        {(pending ?? []).map((p) => (
          <PendingCard key={p.keyId} person={p} />
        ))}
      </div>
    </DetailPanel>
  );
}

function PendingCard({ person }: { person: PendingPersonView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirmKey();
  const reject = useRejectKey();
  const [asking, setAsking] = useState<"confirm" | "reject" | null>(null);
  // Review M7: l'azione fa il suo Touch ID (nel main), niente apertura prima.

  const onConfirm = async () => {
    setAsking(null);
    const out = await confirm.mutateAsync(person.keyId).catch(() => null);
    if (!out?.ok) return void toast.error(t("vault.pending.failed"));
    const parts = [t("vault.pending.now", { name: person.name, count: out.saved })];
    if (out.keyChanged > 0) parts.push(t("vault.pending.changed", { count: out.keyChanged }));
    if (out.notAllowed > 0) parts.push(t("vault.pending.notAllowed", { count: out.notAllowed }));
    toast.show(parts.join(" "));
  };
  const onReject = async () => {
    setAsking(null);
    const out = await reject.mutateAsync(person.keyId).catch(() => null);
    if (!out?.ok) return void toast.error(t("vault.pending.failed"));
    toast.show(t("vault.pending.rejected", { name: person.name }));
  };

  return (
    <article className="flex flex-col gap-2 border-t border-rule pt-3">
      <div className="flex flex-col">
        <span className="text-md font-semibold text-ink">{person.name}</span>
        <span className="text-sm text-ink-muted">{person.email}</span>
      </div>
      <span className="text-sm text-ink-muted">
        {t("vault.pending.created", {
          date: new Date(person.createdAt).toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
        })}
      </span>
      {person.device && (
        <span className="text-sm text-ink-muted">
          {t("vault.pending.device", { device: person.device })}
        </span>
      )}
      <span className="font-mono text-[15px] tabular-nums tracking-wide text-ink">
        {person.fingerprint}
      </span>
      <span className="text-sm text-ink-muted">
        {t("vault.pending.credentials", { count: person.credentials.length })}
      </span>
      {asking === "confirm" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink">
            {t("vault.pending.confirmQuestion", { name: person.name })}
          </p>
          <div className="flex gap-2">
            <button type="button" className={primaryButton} onClick={() => void onConfirm()}>
              {t("vault.pending.confirmYes")}
            </button>
            <button type="button" className={quietButton} onClick={() => setAsking(null)}>
              {t("vault.pending.cancel")}
            </button>
          </div>
        </div>
      ) : asking === "reject" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink">
            {t("vault.pending.rejectQuestion", { name: person.name })}
          </p>
          <div className="flex gap-2">
            <button type="button" className={dangerSolidButton} onClick={() => void onReject()}>
              {t("vault.pending.rejectYes")}
            </button>
            <button type="button" className={quietButton} onClick={() => setAsking(null)}>
              {t("vault.pending.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" className={secondaryButton} onClick={() => setAsking("confirm")}>
            {t("vault.pending.confirm")}
          </button>
          <button type="button" className={quietButton} onClick={() => setAsking("reject")}>
            {t("vault.pending.reject")}
          </button>
        </div>
      )}
    </article>
  );
}
