import { useQuery, useQueryClient } from "@tanstack/react-query";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type { VaultConfirmResponse } from "@stubwise/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormError } from "../field";
import {
  postVaultPendingConfirm,
  postVaultPendingReject,
  type VaultPendingPerson,
} from "../../lib/api";
import { formatDate } from "../../lib/format";
import { vaultPendingQueryOptions } from "../../lib/queries";
import { rewrapForPerson } from "../../lib/vault/credentials";
import { useVault } from "../../lib/vault/vault-context";
import { useWithUnlockedVault } from "./reveal-button";
import { vaultErrorMessage } from "./unlock-dialog";

const buttonClass =
  "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
  "tap rounded-sm bg-signal px-2 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim";

/** L'esito di una conferma: la risposta del server e le copie che il browser non ha potuto aprire. */
export interface ConfirmOutcome {
  result: VaultConfirmResponse;
  failed: string[];
}

interface PendingPeopleProps {
  items: VaultPendingPerson[];
  /** Conferma: risolve `null` se l'utente ha annullato (es. il dialogo della passkey). */
  onConfirm: (person: VaultPendingPerson) => Promise<ConfirmOutcome | null>;
  /** Rifiuto: assente nel recupero, che serve SOLO a confermare. */
  onReject?: (person: VaultPendingPerson) => Promise<void>;
}

/**
 * L'elenco delle persone con un accesso in attesa e le loro schede (design
 * «Lettori che arrivano dopo, e la conferma»): chi è, quando è nata la sua
 * chiave, da quale dispositivo, l'impronta, e quali credenziali riceverebbe.
 * Confermare e rifiutare chiedono un secondo click esplicito — «ho verificato
 * con la persona» — perché un login rubato basta a creare una chiave a nome
 * di qualcuno. Stessa schermata per la conferma normale e per il recupero.
 */
export function PendingPeople({ items, onConfirm, onReject }: PendingPeopleProps) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<string[]>([]);

  return (
    <div className="flex flex-col gap-3">
      {notice.length > 0 && (
        <div role="status" className="flex flex-col gap-1 rounded-sm border border-line bg-ink-900/60 p-3 text-sm">
          {notice.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {items.map((person) => (
        <PersonCard
          key={person.personKey.id}
          person={person}
          onConfirm={async () => {
            const outcome = await onConfirm(person);
            if (outcome) setNotice(confirmNotice(person, outcome, t));
            return outcome !== null;
          }}
          onReject={
            onReject && person.personKey.status === "pending"
              ? async () => {
                  await onReject(person);
                  setNotice([t("vault:pending.rejected", { email: person.user.email })]);
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}

function confirmNotice(
  person: VaultPendingPerson,
  { result, failed }: ConfirmOutcome,
  t: ReturnType<typeof useTranslation>["t"],
): string[] {
  const email = person.user.email;
  const lines = [t("vault:pending.confirmed", { email, count: result.saved?.length ?? 0 })];
  const changed = (result.skipped ?? []).filter((skip) => skip.reason === "key_changed").length;
  if (changed > 0) lines.push(t("vault:pending.keyChanged", { count: changed }));
  const notAllowed = (result.skipped ?? []).filter((skip) => skip.reason === "not_allowed").length;
  if (notAllowed > 0) lines.push(t("vault:pending.notAllowed", { count: notAllowed }));
  if (failed.length > 0) lines.push(t("vault:pending.unopenable", { count: failed.length }));
  return lines;
}

/** L'impronta della chiave pubblica, calcolata nel browser (`keyFingerprint`). */
function useFingerprint(publicKey: string | undefined): string | null {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFingerprint(null);
    if (!publicKey) return undefined;
    keyFingerprint(publicKey).then(
      (value) => alive && setFingerprint(value),
      () => alive && setFingerprint(null),
    );
    return () => {
      alive = false;
    };
  }, [publicKey]);
  return fingerprint;
}

function PersonCard({
  person,
  onConfirm,
  onReject,
}: {
  person: VaultPendingPerson;
  onConfirm: () => Promise<boolean>;
  onReject?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const email = person.user.email;
  const credentials = person.credentials ?? [];
  const fingerprint = useFingerprint(person.personKey.fingerprintSource);
  const [step, setStep] = useState<"idle" | "confirm" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `work` risolve `false` se l'utente ha annullato: la domanda resta aperta, senza errore. */
  async function act(work: () => Promise<boolean>) {
    setError(null);
    setBusy(true);
    try {
      if (await work()) setStep("idle");
    } catch (cause) {
      setError(vaultErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label={email} className="flex flex-col gap-2 rounded-sm border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-fg">{email}</p>
        <p className="font-mono text-[11px] text-fg-muted">
          {t("vault:pending.credentials", { count: credentials.length })}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-fg-muted">{t("vault:pending.keyCreated")}</dt>
        <dd>{formatDate(person.personKey.createdAt)}</dd>
        <dt className="text-fg-muted">{t("vault:pending.device")}</dt>
        <dd>{person.personKey.device ?? t("vault:pending.unknownDevice")}</dd>
        <dt className="text-fg-muted">{t("vault:pending.fingerprint")}</dt>
        <dd className="font-mono">{fingerprint ?? "…"}</dd>
      </dl>
      {person.personKey.status === "confirmed" && (
        <p className="text-[12px] text-fg-muted">{t("vault:pending.alreadyConfirmed")}</p>
      )}
      {credentials.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
          {credentials.map((credential) => (
            <li key={credential.id}>
              {credential.label ? `${credential.service} · ${credential.label}` : credential.service}
            </li>
          ))}
        </ul>
      )}

      {step === "idle" ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            aria-label={t("vault:pending.confirmAria", { email })}
            onClick={() => setStep("confirm")}
          >
            {t("vault:pending.confirm")}
          </button>
          {onReject && (
            <button
              type="button"
              className={buttonClass}
              aria-label={t("vault:pending.rejectAria", { email })}
              onClick={() => setStep("reject")}
            >
              {t("vault:pending.reject")}
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-sm border border-signal/40 bg-signal/10 p-2 text-sm">
          <p>
            {step === "confirm"
              ? t("vault:pending.confirmQuestion", { email })
              : t("vault:pending.rejectQuestion", { email })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryClass}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (step === "confirm") return onConfirm();
                  await onReject?.();
                  return true;
                })
              }
            >
              {busy
                ? t("vault:pending.working")
                : step === "confirm"
                  ? t("vault:pending.confirmYes")
                  : t("vault:pending.rejectYes")}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setStep("idle")}>
              {t("vault:pending.cancel")}
            </button>
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/**
 * «Accessi da confermare» nella cassaforte (sopra «Le mie credenziali»): le
 * persone a cui chi guarda può passare credenziali che legge. Confermare
 * apre la PROPRIA copia di ogni credenziale (serve la cassaforte aperta) e la
 * ricifra per la chiave della persona; il server non vede mai la chiave
 * d'oggetto. Senza nessuno in attesa il pannello non c'è.
 */
export function PendingAccessPanel() {
  const { t } = useTranslation();
  const vault = useVault();
  const queryClient = useQueryClient();
  const { run, dialog } = useWithUnlockedVault();
  const active = vault.state !== "inactive";
  const pending = useQuery({ ...vaultPendingQueryOptions, enabled: active });
  const items = pending.data?.items ?? [];

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: vaultPendingQueryOptions.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["credentials"] }),
    ]);
  }

  function confirm(person: VaultPendingPerson): Promise<ConfirmOutcome | null> {
    return new Promise((resolve, reject) => {
      run(
        ({ privateKey, personKeyId }) => {
          void (async () => {
            const { copies, failed } = await rewrapForPerson(
              person.credentials ?? [],
              { privateKey, recipientId: personKeyId },
              { personKeyId: person.personKey.id, publicKey: person.personKey.fingerprintSource },
            );
            const result = await postVaultPendingConfirm(person.personKey.id, copies);
            await refresh();
            return { result, failed };
          })().then(resolve, reject);
        },
        () => resolve(null),
      );
    });
  }

  async function reject(person: VaultPendingPerson) {
    await postVaultPendingReject(person.personKey.id);
    await refresh();
  }

  if (!active) return null;
  if (pending.isError) return <FormError message={vaultErrorMessage(pending.error, t)} />;
  if (items.length === 0) return null;

  return (
    <section aria-label={t("vault:pending.title")} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 border-b border-line pb-2">
        <h2 className="font-mono text-[12px] tracking-[0.18em] text-fg-muted uppercase">
          {t("vault:pending.title")}
        </h2>
        <span
          data-testid="pending-access-count"
          aria-label={t("vault:pending.countAria", { count: items.length })}
          className="rounded-full bg-signal px-2 font-mono text-[11px] font-semibold text-ink-950"
        >
          {items.length}
        </span>
      </div>
      <p className="max-w-2xl text-sm text-fg-muted">{t("vault:pending.intro")}</p>
      <PendingPeople items={items} onConfirm={confirm} onReject={reject} />
      {dialog}
    </section>
  );
}
