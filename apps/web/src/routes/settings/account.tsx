import type { Language } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { patchMyLanguage, putMyFollows, putNotificationPrefs } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import {
  myFollowsQueryOptions,
  notificationPrefsQueryOptions,
  projectsQueryOptions,
} from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";

/**
 * Sotto-pagina Account: i dati dell'utente corrente (email, ruolo), il
 * selettore di lingua, i progetti seguiti e le preferenze di notifica.
 * Visibile a tutti gli utenti autenticati (sono preferenze PERSONALI, non
 * amministrazione). Il logout vive nella sidebar del layout.
 */
export function SettingsAccountPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  // Cambio lingua: persiste la preferenza sul server, allinea subito la UI e
  // aggiorna la cache `me` così resta coerente con il valore appena salvato.
  const languageMutation = useMutation({
    mutationFn: (language: Language) => patchMyLanguage(language),
    onSuccess: async (_data, language) => {
      await i18n.changeLanguage(language);
      queryClient.setQueryData(meQueryOptions.queryKey, (prev) =>
        prev ? { ...prev, user: { ...prev.user, language } } : prev,
      );
    },
  });

  return (
    <div className="space-y-5">
      <section className="rounded-sm border border-line bg-ink-900">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:account.title")}
          </h2>
        </header>
        <dl className="space-y-3 px-4 py-4">
          <div className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("settings:account.email")}
            </dt>
            <dd className="font-mono text-[13px] text-fg">{me.user.email}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("settings:account.role")}
            </dt>
            <dd>
              <span
                className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
                  isAdmin ? "border-signal-dim/40 text-signal" : "border-line-strong text-fg-muted"
                }`}
              >
                {isAdmin ? t("settings:account.admin") : t("settings:account.member")}
              </span>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="account-language"
              className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
            >
              {t("settings:account.language")}
            </label>
            <select
              id="account-language"
              value={me.user.language}
              disabled={languageMutation.isPending}
              onChange={(event) => languageMutation.mutate(event.target.value as Language)}
              className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="en">{t("settings:account.languageEnglish")}</option>
              <option value="it">{t("settings:account.languageItalian")}</option>
            </select>
          </div>
        </dl>
      </section>

      <FollowedProjectsSection />
      <NotificationPrefsSection />
    </div>
  );
}

const sectionClass = "rounded-sm border border-line bg-ink-900";
const sectionHeaderClass = "border-b border-line px-4 py-3";
const sectionTitleClass =
  "font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";
const sectionSubtitleClass = "mt-1 text-[12px] text-fg-muted";

/**
 * Progetti seguiti: una checkbox per progetto.
 *
 * SALVATAGGIO IMMEDIATO al click, senza bottone Salva: è il pattern già usato
 * dal selettore di lingua qui sopra, e la PUT sostituisce comunque l'insieme
 * completo (nessun delta da comporre). L'aggiornamento è ottimistico con
 * rollback: la checkbox si muove subito e torna indietro se il server rifiuta.
 * Niente debounce — un click è già la granularità della richiesta.
 */
function FollowedProjectsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: follows } = useSuspenseQuery(myFollowsQueryOptions);

  const followed = new Set(follows.projectIds);

  const mutation = useMutation({
    mutationFn: (projectIds: string[]) => putMyFollows(projectIds),
    onMutate: async (projectIds) => {
      // Un refetch in volo atterrerebbe dopo il patch ottimistico rimettendo
      // la checkbox com'era: prima si cancella.
      await queryClient.cancelQueries({ queryKey: myFollowsQueryOptions.queryKey });
      const previous = queryClient.getQueryData(myFollowsQueryOptions.queryKey);
      queryClient.setQueryData(myFollowsQueryOptions.queryKey, { projectIds });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(myFollowsQueryOptions.queryKey, context.previous);
      }
    },
    // Anche dopo un rollback l'insieme va riallineato al server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: myFollowsQueryOptions.queryKey }),
  });

  function toggle(projectId: string, checked: boolean): void {
    const next = new Set(follows.projectIds);
    if (checked) next.add(projectId);
    else next.delete(projectId);
    mutation.mutate([...next]);
  }

  return (
    <section className={sectionClass} aria-label={t("settings:account.follows.title")}>
      <header className={sectionHeaderClass}>
        <h2 className={sectionTitleClass}>{t("settings:account.follows.title")}</h2>
        <p className={sectionSubtitleClass}>{t("settings:account.follows.subtitle")}</p>
      </header>
      <div className="px-4 py-4">
        {projects.length === 0 ? (
          <p className="font-mono text-[12px] text-fg-faint">
            {t("settings:account.follows.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => (
              <li key={project.id}>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={followed.has(project.id)}
                    disabled={mutation.isPending}
                    onChange={(event) => toggle(project.id, event.target.checked)}
                    className="size-4 accent-[var(--color-signal)] disabled:cursor-not-allowed"
                  />
                  <span>{project.name}</span>
                  <span className="font-mono text-[11px] text-fg-faint">{project.slug}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-3 font-mono text-[12px] text-danger">
            {translateApiError(mutation.error, t)}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Canali di notifica: oggi solo il DM Slack (l'inbox in-app non è
 * disattivabile). Stesso salvataggio immediato con rollback dei follow.
 *
 * Senza identità Slack collegata il toggle è DISABILITATO: acceso, il canale
 * resterebbe muto — meglio dirlo che far credere di aver attivato qualcosa.
 * Collegare l'identità è un'azione da maintainer (pagina /team), non
 * self-service: l'hint indirizza lì.
 */
function NotificationPrefsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: prefs } = useSuspenseQuery(notificationPrefsQueryOptions);

  const mutation = useMutation({
    mutationFn: (slackDm: boolean) => putNotificationPrefs({ slackDm }),
    onMutate: async (slackDm) => {
      await queryClient.cancelQueries({ queryKey: notificationPrefsQueryOptions.queryKey });
      const previous = queryClient.getQueryData(notificationPrefsQueryOptions.queryKey);
      queryClient.setQueryData(notificationPrefsQueryOptions.queryKey, (current) =>
        // `slackLinked` è contesto del server, non una preferenza: si conserva.
        current ? { ...current, slackDm } : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(notificationPrefsQueryOptions.queryKey, context.previous);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: notificationPrefsQueryOptions.queryKey }),
  });

  return (
    <section className={sectionClass} aria-label={t("settings:account.notifications.title")}>
      <header className={sectionHeaderClass}>
        <h2 className={sectionTitleClass}>{t("settings:account.notifications.title")}</h2>
        <p className={sectionSubtitleClass}>{t("settings:account.notifications.subtitle")}</p>
      </header>
      <div className="px-4 py-4">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={prefs.slackDm}
            disabled={!prefs.slackLinked || mutation.isPending}
            onChange={(event) => mutation.mutate(event.target.checked)}
            className="size-4 accent-[var(--color-signal)] disabled:cursor-not-allowed"
          />
          <span className={prefs.slackLinked ? undefined : "text-fg-muted"}>
            {t("settings:account.notifications.slackDm")}
          </span>
        </label>
        {!prefs.slackLinked && (
          <p className="mt-2 font-mono text-[11px] text-fg-muted">
            {t("settings:account.notifications.slackNotLinked")}
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-3 font-mono text-[12px] text-danger">
            {translateApiError(mutation.error, t)}
          </p>
        )}
      </div>
    </section>
  );
}
