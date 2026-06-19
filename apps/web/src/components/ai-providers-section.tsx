import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createAiProvider,
  deleteAiProvider,
  reorderAiProviders,
  updateAiProvider,
  type AiProvider,
  type AiProviderKind,
} from "../lib/api";
import { aiProvidersQueryOptions } from "../lib/queries";
import { FormError, SelectField, SubmitButton, TextField } from "./field";

/**
 * Sezione "AI providers" delle impostazioni (solo admin): catena ordinata delle
 * credenziali per la pipeline AI. Ogni riga mostra label, tipo (API key /
 * Account), stato attivo e la sola indicazione che la secret è impostata — la
 * secret è write-only e non viene MAI mostrata. Azioni: aggiungi, riordina
 * (su/giù → POST /reorder con l'insieme completo degli id), enable/disable
 * (PATCH { enabled }), elimina (con conferma).
 *
 * Modifica della secret: non supportata in-place (resta write-only). Si può
 * cambiare label/enabled e riordinare; per sostituire una secret si elimina il
 * provider e lo si ricrea — scelta documentata negli hint del form.
 *
 * Avviso ToS: calcolato client-side dalla lista. Con ≥2 credenziali di tipo
 * `account` mostra un callout: usare più abbonamenti per superare i limiti è
 * contro i ToS Anthropic (rischio sospensione).
 */
export function AiProvidersSection() {
  const { t } = useTranslation();
  const { data: providers } = useSuspenseQuery(aiProvidersQueryOptions);
  const [creating, setCreating] = useState(false);

  // Ordine di failover esplicito (la query li restituisce già per position).
  const ordered = [...providers].sort((a, b) => a.position - b.position);
  const orderedIds = ordered.map((p) => p.id);
  const accountCount = ordered.filter((p) => p.kind === "account").length;

  return (
    <section className="rounded-sm border border-line bg-ink-900 lg:col-span-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:aiProviders.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:aiProviders.subtitle")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:aiProviders.newProvider")}
          </button>
        )}
      </header>

      {accountCount >= 2 && (
        <p
          role="alert"
          className="border-b border-signal/30 bg-signal/10 px-4 py-3 font-mono text-[12px] leading-relaxed text-signal"
        >
          {t("settings:aiProviders.tosWarning")}
        </p>
      )}

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewProviderForm onDone={() => setCreating(false)} />
        </div>
      )}

      {ordered.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:aiProviders.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {ordered.map((provider, index) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              orderedIds={orderedIds}
              index={index}
              isFirst={index === 0}
              isLast={index === ordered.length - 1}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Form di creazione: tipo (api_key/account), label e secret (password). Sul
 * successo invalida la lista e si chiude. L'hint cambia col tipo selezionato.
 */
function NewProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<AiProviderKind>("api_key");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");

  const mutation = useMutation({
    mutationFn: () => createAiProvider({ kind, label, secret }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiProvidersQueryOptions.queryKey });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <SelectField
        id="new-ai-provider-kind"
        label={t("settings:aiProviders.kind")}
        value={kind}
        onChange={(event) => setKind(event.target.value as AiProviderKind)}
        options={[
          { value: "api_key", label: t("settings:aiProviders.kindApiKey") },
          { value: "account", label: t("settings:aiProviders.kindAccount") },
        ]}
      />
      <TextField
        id="new-ai-provider-label"
        label={t("settings:aiProviders.label")}
        required
        placeholder={t("settings:aiProviders.labelPlaceholder")}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id="new-ai-provider-secret"
          type="password"
          label={t("settings:aiProviders.secret")}
          required
          placeholder={t("settings:aiProviders.secretPlaceholder")}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <p className="font-mono text-[11px] text-fg-faint">
          {kind === "account"
            ? t("settings:aiProviders.accountHint")
            : t("settings:aiProviders.apiKeyHint")}
        </p>
        <p className="font-mono text-[11px] text-fg-faint">
          {t("settings:aiProviders.secretWriteOnlyHint")}
        </p>
      </div>

      <FormError message={mutation.error instanceof Error ? mutation.error.message : null} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending
            ? t("settings:aiProviders.creatingProvider")
            : t("settings:aiProviders.createProvider")}
        </SubmitButton>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Riga di una credenziale: label, badge tipo/stato, e azioni Su / Giù /
 * Enable-Disable / Elimina. Il riordino ricostruisce l'insieme COMPLETO degli
 * id e chiama /reorder; l'enable/disable è un PATCH { enabled }.
 */
function ProviderRow({
  provider,
  orderedIds,
  index,
  isFirst,
  isLast,
}: {
  provider: AiProvider;
  orderedIds: string[];
  index: number;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const reorder = useMutation({
    mutationFn: (next: string[]) => reorderAiProviders(next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiProvidersQueryOptions.queryKey });
    },
  });

  const toggle = useMutation({
    mutationFn: () => updateAiProvider(provider.id, { enabled: !provider.enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiProvidersQueryOptions.queryKey });
    },
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletion = useMutation({
    mutationFn: () => deleteAiProvider(provider.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiProvidersQueryOptions.queryKey });
    },
  });

  // Scambia con il vicino e rimanda l'insieme completo nel nuovo ordine.
  function move(direction: -1 | 1) {
    const next = [...orderedIds];
    const target = index + direction;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next);
  }

  const busy = reorder.isPending || toggle.isPending || deletion.isPending;
  const error = [reorder.error, toggle.error, deletion.error].find((e) => e instanceof Error);

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] text-fg-faint">{index + 1}.</span>
        <span className="text-[14px] font-medium text-fg">{provider.label}</span>
        <KindBadge kind={provider.kind} />
        <span
          className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
            provider.enabled ? "border-ok/40 text-ok" : "border-line-strong text-fg-faint"
          }`}
        >
          {provider.enabled
            ? t("settings:aiProviders.enabledBadge")
            : t("settings:aiProviders.disabledBadge")}
        </span>
        {provider.secretSet && (
          <span className="font-mono text-[11px] whitespace-nowrap text-fg-faint">
            {t("settings:aiProviders.secretSet")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => move(-1)}
            disabled={busy || isFirst}
            label={t("settings:aiProviders.moveUp")}
          />
          <RowButton
            onClick={() => move(1)}
            disabled={busy || isLast}
            label={t("settings:aiProviders.moveDown")}
          />
          <RowButton
            onClick={() => toggle.mutate()}
            disabled={busy}
            label={
              provider.enabled
                ? t("settings:aiProviders.disable")
                : t("settings:aiProviders.enable")
            }
          />
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={busy}
                label={t("settings:aiProviders.confirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              label={t("settings:aiProviders.delete")}
              danger
            />
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {error.message}
        </p>
      )}
    </li>
  );
}

/** Badge del tipo di credenziale: API key / Account. */
function KindBadge({ kind }: { kind: AiProviderKind }) {
  const { t } = useTranslation();
  return (
    <span className="rounded-sm border border-line-strong px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
      {kind === "account"
        ? t("settings:aiProviders.kindAccount")
        : t("settings:aiProviders.kindApiKey")}
    </span>
  );
}

function RowButton({
  onClick,
  label,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "border-danger/30 text-danger hover:border-danger/60"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
