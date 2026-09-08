import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ComboboxPicker } from "./combobox-picker";
import { LabelsEditor } from "./labels-editor";
import { putProjectEmailRoutes, type EmailRoute, type EmailRouteKind } from "../lib/api";
import {
  projectEmailLabelsQueryOptions,
  projectEmailRoutesQueryOptions,
} from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

/**
 * Sezione «Posta» del dettaglio progetto (Fase 6): le regole che decidono quali
 * email parlano di questo progetto.
 *
 * ⚠️ Dalla fase 6c queste regole NON decidono più se un'email entra in
 * Stubwise: decidono solo A QUALE PROGETTO va un'email GIÀ AMMESSA.
 * L'ammissione (quali email entrano nella pipeline) è configurazione
 * d'istanza, in Impostazioni → Google → «Posta ammessa» — non una regola di
 * progetto. Per questo la scrittura resta solo admin (il server risponde 403
 * a un member) mentre la lettura è di chiunque veda il progetto: sapere a
 * quale progetto va la posta ammessa non è un privilegio da maintainer.
 *
 * Sezione SECONDARIA: `useQuery` (non suspense) e loading/errore inline, così
 * un suo fallimento degrada solo qui (pattern di `ProjectPluginsSection`).
 *
 * SALVATAGGIO IMMEDIATO: ogni chip aggiunto o tolto manda subito un PUT con
 * l'INSIEME COMPLETO. Il body si costruisce SEMPRE dalla foto del server tenuta
 * in cache, mai da uno stato locale del form: il PUT è una sostituzione, e un
 * body nato da uno stato stantio cancellerebbe le regole scritte da altri.
 *
 * ⚠️ La risposta del PUT è la verità, non il body: il server normalizza i valori
 * (minuscolo, indirizzo estratto da «Mario <m@acme.com>», dominio senza `@`)
 * con la STESSA funzione che il poller usa per confrontare. La cache si
 * riconcilia con la risposta, così i chip mostrano ciò che filtrerà davvero.
 */
export function ProjectEmailRoutesSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const routesKey = projectEmailRoutesQueryOptions(projectId).queryKey;
  const routes = useQuery(projectEmailRoutesQueryOptions(projectId));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: EmailRoute[]) => putProjectEmailRoutes(projectId, next),
    onMutate: async (next) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: routesKey });
      const previous = queryClient.getQueryData(routesKey);
      queryClient.setQueryData(routesKey, { routes: next });
      return { previous };
    },
    onSuccess: (data) => queryClient.setQueryData(routesKey, data),
    onError: (err, _next, context) => {
      if (context?.previous) queryClient.setQueryData(routesKey, context.previous);
      setError(translateApiError(err, t));
    },
    // Un refetch partito DURANTE il PUT non è stato cancellato dall'`onMutate`
    // e potrebbe atterrare dopo la riconciliazione: l'invalidazione finale
    // chiude la finestra.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: routesKey }),
  });

  if (routes.isPending) {
    return (
      <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
        {t("projects:email.loading")}
      </p>
    );
  }

  if (routes.isError) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3">
        <p className="font-mono text-[12px] text-danger">{t("projects:email.error")}</p>
      </div>
    );
  }

  const current = routes.data.routes;
  const disabled = !isAdmin || save.isPending;

  /**
   * Sostituisce le regole di UNO dei tre gruppi lasciando intatti gli altri
   * due. `classify` traduce il testo del chip nel criterio giusto — è il solo
   * punto in cui la UI decide un `kind`.
   */
  function replaceGroup(
    kinds: EmailRouteKind[],
    values: string[],
    classify: (value: string) => EmailRouteKind,
  ) {
    const others = current.filter((route) => !kinds.includes(route.kind));
    save.mutate([...others, ...values.map((value) => ({ kind: classify(value), value }))]);
  }

  const senders = current
    .filter((route) => route.kind === "sender_domain" || route.kind === "sender_address")
    .map((route) => route.value);
  const labels = current.filter((route) => route.kind === "gmail_label").map((r) => r.value);
  const keywords = current.filter((route) => route.kind === "keyword").map((r) => r.value);

  return (
    <div className="flex flex-col gap-5">
      <p className="rounded-sm border border-line-strong bg-ink-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-fg-muted">
        {t("projects:email.perimeterWarning")}
      </p>

      {current.length === 0 && (
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:email.empty")}</p>
      )}

      <Group
        title={t("projects:email.senders")}
        hint={t("projects:email.sendersHint")}
        labels={senders}
        disabled={disabled}
        onChange={(values) =>
          replaceGroup(["sender_domain", "sender_address"], values, classifySender)
        }
      />

      <Group
        title={t("projects:email.labels")}
        hint={t("projects:email.labelsHint")}
        labels={labels}
        disabled={disabled}
        onChange={(values) => replaceGroup(["gmail_label"], values, () => "gmail_label")}
      >
        {isAdmin && (
          <ObservedLabelsPicker
            projectId={projectId}
            disabled={disabled}
            onPick={(label) => {
              if (labels.includes(label)) return;
              replaceGroup(["gmail_label"], [...labels, label], () => "gmail_label");
            }}
          />
        )}
      </Group>

      <Group
        title={t("projects:email.keywords")}
        hint={t("projects:email.keywordsHint")}
        labels={keywords}
        disabled={disabled}
        onChange={(values) => replaceGroup(["keyword"], values, () => "keyword")}
      />

      {error && (
        <p role="alert" className="font-mono text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Un chip del gruppo mittenti è un DOMINIO o un INDIRIZZO a seconda di come è
 * scritto: `acme.com` è il dominio, `mario@acme.com` la singola casella. È la
 * scelta che evita un terzo editor per una distinzione che chi scrive fa già
 * digitando (o non digitando) la chiocciola. `@acme.com` — la grafia mentale
 * del dominio — resta un dominio: non c'è parte locale davanti alla chiocciola.
 */
export function classifySender(value: string): EmailRouteKind {
  const at = value.indexOf("@");
  return at > 0 ? "sender_address" : "sender_domain";
}

/** Titolo + spiegazione + editor a chip di un gruppo di regole. */
function Group({
  title,
  hint,
  labels,
  disabled,
  onChange,
  children,
}: {
  title: string;
  hint: string;
  labels: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
  children?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div>
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
          {title}
        </h3>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{hint}</p>
      </div>
      <LabelsEditor labels={labels} onChange={onChange} disabled={disabled} />
      {children}
    </section>
  );
}

/**
 * Picker delle etichette GIÀ OSSERVATE nella posta di chi guarda: si sceglie da
 * un elenco invece di indovinare il nome esatto di una label Gmail.
 *
 * Se non c'è ancora posta ingerita la lista è vuota e il bottone resta
 * silenzioso: l'editor a chip sopra accetta comunque il testo libero, quindi la
 * mancanza di suggerimenti non impedisce di scrivere una regola.
 */
function ObservedLabelsPicker({
  projectId,
  disabled,
  onPick,
}: {
  projectId: string;
  disabled: boolean;
  onPick: (label: string) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const observed = useQuery({
    ...projectEmailLabelsQueryOptions(projectId),
    enabled: picking,
  });

  if (!picking) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setPicking(true)}
        className="self-start rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50"
      >
        {t("projects:email.pickLabel")}
      </button>
    );
  }

  const items = observed.data?.labels ?? [];
  if (observed.isSuccess && items.length === 0) {
    return (
      <p className="font-mono text-[11px] text-fg-faint">
        {t("projects:email.noObservedLabels")}{" "}
        <button
          type="button"
          onClick={() => setPicking(false)}
          className="underline-offset-2 hover:underline"
        >
          {t("projects:email.cancel")}
        </button>
      </p>
    );
  }

  return (
    <ComboboxPicker<string>
      items={items}
      getKey={(label) => label}
      matches={(label, query) => label.toLowerCase().includes(query)}
      isDisabled={() => false}
      renderOption={(label) => <span className="min-w-0 truncate text-fg">{label}</span>}
      onPick={(label) => {
        setPicking(false);
        onPick(label);
      }}
      pending={observed.isPending}
      pendingLabel={t("projects:email.loadingLabels")}
      onCancel={() => setPicking(false)}
      labels={{
        pickerLabel: t("projects:email.pickLabel"),
        placeholder: t("projects:email.pickLabelPlaceholder"),
        noResults: t("projects:email.labelNoResults"),
        cancel: t("projects:email.cancel"),
        moreResults: (count) => t("projects:email.labelMoreResults", { count }),
      }}
      // Testo libero: una label appena creata in Gmail non è ancora comparsa in
      // nessun messaggio ingerito, e il picker non deve impedire di nominarla.
      freeText={{
        canSubmit: (query) => query.trim() !== "",
        label: (query) => t("projects:email.useTypedLabel", { value: query.trim() }),
        onSubmit: (query) => {
          setPicking(false);
          onPick(query.trim());
        },
      }}
    />
  );
}
