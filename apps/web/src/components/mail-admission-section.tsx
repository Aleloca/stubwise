import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LabelsEditor } from "./labels-editor";
import { patchMailAdmission, type MailAdmissionPatch } from "../lib/api";
import { googleWorkspacesQueryOptions, mailAdmissionQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

/**
 * Sezione «Posta ammessa» di Impostazioni → Google (fase 6c): decide SE un
 * messaggio entra nella pipeline, non a quale progetto va (quello resta la
 * sezione «Posta» del progetto, `ProjectEmailRoutesSection`).
 *
 * LETTURA per ogni utente autenticato (la rotta `GET /mail-admission` è aperta
 * a tutti, vedi il commento sulla rotta lato server); SCRITTURA solo admin —
 * `isAdmin` disabilita input ed editor, stesso pattern di
 * `GoogleWorkspacesSection`/`ProjectEmailRoutesSection`. Il chiamante (
 * `SettingsGooglePage`) decide il ruolo una volta sola.
 *
 * L'elenco dei domini che verrebbero ammessi è SOLO in lettura qui (si
 * modificano registrando o editando un Workspace, non da questa sezione): lo
 * deriva dagli stessi Workspace registrati che `GoogleWorkspacesSection`
 * mostra, riusando `googleWorkspacesQueryOptions` invece di duplicare la
 * query. Quella rotta è SOLO admin, quindi la lista compare solo per un
 * admin — a un member la casella del toggle basta a sapere COSA è acceso,
 * senza poter vedere l'elenco esatto dei domini (403 se lo chiedesse).
 *
 * ⚠️ «I tetti» (`GMAIL_MAX_PER_DAY`, `GMAIL_THREAD_COOLDOWN_MINUTES`) NON
 * sono qui: sono env del worker, non esposte da nessuna rotta — vedi il
 * report del task per la motivazione. Se una fase successiva li espone via
 * API, questa sezione è il punto naturale in cui aggiungerli.
 */
export function MailAdmissionSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: admission } = useSuspenseQuery(mailAdmissionQueryOptions);

  // Solo un admin può leggere il registro dei Workspace (rotta admin-only):
  // per un member la query resta disabilitata, niente 403 in console.
  const workspaces = useQuery({ ...googleWorkspacesQueryOptions, enabled: isAdmin });
  const domains = [...new Set(workspaces.data?.flatMap((workspace) => workspace.domains) ?? [])].sort();

  const mutation = useMutation({
    mutationFn: (patch: MailAdmissionPatch) => patchMailAdmission(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: mailAdmissionQueryOptions.queryKey });
      const previous = queryClient.getQueryData(mailAdmissionQueryOptions.queryKey);
      queryClient.setQueryData(mailAdmissionQueryOptions.queryKey, (current) =>
        current ? { ...current, ...patch } : current,
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(mailAdmissionQueryOptions.queryKey, context.previous);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: mailAdmissionQueryOptions.queryKey }),
  });

  const disabled = !isAdmin || mutation.isPending;

  return (
    <section className="mt-6 rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("settings:google.mailAdmission.title")}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("settings:google.mailAdmission.subtitle")}
        </p>
      </header>

      <div className="flex flex-col gap-5 px-4 py-4">
        {/* Consenso informato, non una rifinitura estetica: prima di
            toccare l'interruttore dei domini di lavoro, chi legge deve
            sapere che ammissione = oggetto e corpo inviati fuori
            Stubwise, al provider AI di classificazione. */}
        <p className="rounded-sm border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          {t("settings:google.mailAdmission.dataUsageNotice")}
        </p>

        <div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={admission.admitWorkspaceDomains}
              disabled={disabled}
              onChange={(event) => mutation.mutate({ admitWorkspaceDomains: event.target.checked })}
              className="size-4 accent-signal disabled:cursor-not-allowed"
            />
            <span>{t("settings:google.mailAdmission.admitWorkspaceDomainsLabel")}</span>
          </label>
          <p className="mt-1 ml-6 font-mono text-[11px] text-fg-faint">
            {t("settings:google.mailAdmission.admitWorkspaceDomainsHint")}
          </p>

          {isAdmin && (
            <div className="mt-2 ml-6">
              <h3 className="font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
                {t("settings:google.mailAdmission.domainsTitle")}
              </h3>
              {workspaces.isPending ? (
                <p className="mt-1 font-mono text-[11px] text-fg-faint">
                  {t("settings:google.mailAdmission.domainsLoading")}
                </p>
              ) : domains.length === 0 ? (
                <p className="mt-1 font-mono text-[11px] text-fg-faint">
                  {t("settings:google.mailAdmission.domainsEmpty")}
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {domains.map((domain) => (
                    <li
                      key={domain}
                      className="rounded-sm border border-line bg-ink-800/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                    >
                      {domain}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div>
          <h3 className="font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase">
            {t("settings:google.mailAdmission.denyLabelsLabel")}
          </h3>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:google.mailAdmission.denyLabelsHint")}
          </p>
          <div className="mt-2">
            <LabelsEditor
              labels={admission.denyLabels}
              disabled={disabled}
              onChange={(next) => mutation.mutate({ denyLabels: next })}
            />
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={admission.denyAutomated}
              disabled={disabled}
              onChange={(event) => mutation.mutate({ denyAutomated: event.target.checked })}
              className="size-4 accent-signal disabled:cursor-not-allowed"
            />
            <span>{t("settings:google.mailAdmission.denyAutomatedLabel")}</span>
          </label>
          <p className="mt-1 ml-6 font-mono text-[11px] text-fg-faint">
            {t("settings:google.mailAdmission.denyAutomatedHint")}
          </p>
        </div>

        {mutation.isError && (
          <p role="alert" className="font-mono text-[12px] text-danger">
            {translateApiError(mutation.error, t)}
          </p>
        )}
      </div>
    </section>
  );
}
