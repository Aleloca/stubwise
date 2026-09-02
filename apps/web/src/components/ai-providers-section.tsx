import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createAiProvider,
  deleteAiProvider,
  reorderAiProviders,
  testAiProvider,
  updateAiProvider,
  type AiProvider,
  type AiProviderKind,
  type AiUsageSnapshot,
} from "../lib/api";
import { aiProvidersQueryOptions, aiUsageSnapshotsQueryOptions } from "../lib/queries";
import { FormError, SelectField, SubmitButton, TextField } from "./field";
import { RowButton } from "./row-button";

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

  // Ultimo snapshot di consumo per credenziale `account`. Non-suspense: se la
  // query non è ancora pronta le righe mostrano "no data yet"; quando arriva
  // si popolano. Indicizzata per providerId per evitare lookup ripetuti.
  const { data: snapshots } = useQuery(aiUsageSnapshotsQueryOptions);
  const snapshotByProvider = new Map<string, AiUsageSnapshot>(
    (snapshots ?? []).map((s) => [s.providerId, s]),
  );

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
              snapshot={snapshotByProvider.get(provider.id) ?? null}
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
  snapshot,
  orderedIds,
  index,
  isFirst,
  isLast,
}: {
  provider: AiProvider;
  snapshot: AiUsageSnapshot | null;
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

  // Test della credenziale: il server marca `pending`, il worker esegue il
  // `claude -p` di prova e scrive l'esito; la lista fa polling (refetchInterval
  // in aiProvidersQueryOptions) finché lo stato lascia `pending`.
  const test = useMutation({
    mutationFn: () => testAiProvider(provider.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiProvidersQueryOptions.queryKey });
    },
  });
  // `pending` è guidato dal DB (lo scrive il server e lo azzera il worker): la
  // mutazione in volo è solo il breve istante prima della risposta. Entrambi
  // mettono il bottone in stato "testing…".
  const testing = test.isPending || provider.testStatus === "pending";

  // Scambia con il vicino e rimanda l'insieme completo nel nuovo ordine.
  function move(direction: -1 | 1) {
    const next = [...orderedIds];
    const target = index + direction;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next);
  }

  const busy = reorder.isPending || toggle.isPending || deletion.isPending;
  const error = [reorder.error, toggle.error, deletion.error, test.error].find(
    (e) => e instanceof Error,
  );

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
        <TestBadge status={provider.testStatus} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowButton
            onClick={() => test.mutate()}
            disabled={busy || testing}
            label={
              testing ? t("settings:aiProviders.testing") : t("settings:aiProviders.test")
            }
          />
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

      {provider.testStatus === "failed" && provider.testError && (
        <p role="alert" className="mt-2 font-mono text-[12px] leading-relaxed text-danger">
          {t("settings:aiProviders.testFailed")}: {provider.testError}
        </p>
      )}

      {provider.kind === "account" && <UsagePanel snapshot={snapshot} />}
    </li>
  );
}

/**
 * Pannello del consumo residuo dell'abbonamento sotto una credenziale `account`:
 * residuo della finestra di sessione (5h) e settimanale dell'ULTIMO snapshot,
 * con reset se presente ed etichetta "estimated (fallback)" quando il dato è
 * dedotto via LLM (source=llm_fallback). Se l'ultimo snapshot ha parseOk=false
 * mostra anche il banner di diagnosi (rawText + hint sul parser). "no data yet"
 * se non c'è ancora alcuno snapshot per la credenziale.
 */
function UsagePanel({ snapshot }: { snapshot: AiUsageSnapshot | null }) {
  const { t, i18n } = useTranslation();
  // Il testo grezzo parte mostrato (la diagnosi serve subito); il toggle lo
  // collassa per non ingombrare quando l'admin l'ha già visto.
  const [showRaw, setShowRaw] = useState(true);

  if (!snapshot) {
    return (
      <p className="mt-2 font-mono text-[11px] text-fg-faint">
        {t("settings:aiProviders.usage.noData")}
      </p>
    );
  }

  // Il reset preferito è la label testuale della TUI (non-ISO, es.
  // "2:39pm (Europe/Rome)"); per retrocompatibilità coi vecchi snapshot che
  // avevano un ISO si formatta quello come fallback.
  const fmtIso = (iso: string | null): string | null =>
    iso ? new Date(iso).toLocaleString(i18n.language) : null;
  const resetOf = (
    label: string | null | undefined,
    iso: string | null,
  ): string | null => label ?? fmtIso(iso);

  const sessionReset = resetOf(snapshot.sessionRemaining?.resetsLabel, snapshot.sessionResetAt);
  const weeklyReset = resetOf(snapshot.weeklyRemaining?.resetsLabel, snapshot.weeklyResetAt);

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-l-2 border-line pl-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-muted">
        <span className="tracking-[0.1em] text-fg-faint uppercase">
          {t("settings:aiProviders.usage.title")}
        </span>
        {snapshot.sessionRemaining && (
          <span>
            {t("settings:aiProviders.usage.session", {
              percent: snapshot.sessionRemaining.percentRemaining,
            })}
            {sessionReset && (
              <span className="text-fg-faint">
                {" "}
                ({t("settings:aiProviders.usage.resets", { when: sessionReset })})
              </span>
            )}
          </span>
        )}
        {snapshot.weeklyRemaining && (
          <span>
            {t("settings:aiProviders.usage.weekly", {
              percent: snapshot.weeklyRemaining.percentRemaining,
            })}
            {weeklyReset && (
              <span className="text-fg-faint">
                {" "}
                ({t("settings:aiProviders.usage.resets", { when: weeklyReset })})
              </span>
            )}
          </span>
        )}
        {snapshot.source === "llm_fallback" && (
          <span className="rounded-sm border border-line-strong px-1.5 py-0.5 text-fg-faint">
            {t("settings:aiProviders.usage.estimated")}
          </span>
        )}
      </div>

      {!snapshot.parseOk && (
        <div
          role="alert"
          className="mt-1 rounded-sm border border-signal/30 bg-signal/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-signal"
        >
          <p className="font-semibold">{t("settings:aiProviders.usage.diagnoseTitle")}</p>
          <p className="mt-1 text-signal/90">{t("settings:aiProviders.usage.diagnoseHint")}</p>
          {snapshot.rawText && (
            <>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="mt-2 rounded-sm border border-signal/40 px-2 py-0.5 text-[11px] tracking-[0.08em] uppercase transition-colors hover:bg-signal/20"
              >
                {showRaw
                  ? t("settings:aiProviders.usage.hideRaw")
                  : t("settings:aiProviders.usage.showRaw")}
              </button>
              {showRaw && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-sm border border-line bg-ink-950/70 p-2 text-[11px] whitespace-pre-wrap text-fg-muted">
                  {snapshot.rawText}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Badge dell'esito dell'ultimo test della credenziale. `idle` non mostra nulla
 * (mai testata); `pending` un'attesa neutra; `passed`/`failed` un ✅/❌ colorato.
 */
function TestBadge({ status }: { status: AiProvider["testStatus"] }) {
  const { t } = useTranslation();
  if (status === "idle") return null;

  const map = {
    pending: { text: t("settings:aiProviders.testing"), cls: "border-line-strong text-fg-faint" },
    passed: { text: `✓ ${t("settings:aiProviders.testPassed")}`, cls: "border-ok/40 text-ok" },
    failed: { text: `✕ ${t("settings:aiProviders.testFailedBadge")}`, cls: "border-danger/40 text-danger" },
  } as const;
  const { text, cls } = map[status];

  return (
    <span
      className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase ${cls}`}
    >
      {text}
    </span>
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
