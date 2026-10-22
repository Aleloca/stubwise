import { GoogleWorkspacesSection } from "../../components/google-workspaces-section";
import { MailAdmissionSection } from "../../components/mail-admission-section";
import { useSuspenseQuery } from "@tanstack/react-query";
import { meQueryOptions } from "../../lib/auth";
import { hasPermission } from "../../lib/permissions";

/**
 * Sotto-pagina Google: il registro dei Google Workspace (le app OAuth interne
 * su cui gli operatori collegano le proprie caselle Gmail e Calendar, SOLO
 * admin) e, dalla fase 6c, la sezione «Posta ammessa» (decide SE un messaggio
 * entra nella pipeline, non a quale progetto va).
 *
 * ⚠️ La rotta `/settings/google` NON ha più `beforeLoad: requireAdmin` (vedi
 * router.tsx): il design della fase 6c chiede la sezione «Posta ammessa»
 * VISIBILE A TUTTI (lettura, `GET /api/settings/mail-admission` è aperta a
 * ogni utente autenticato) e SCRIVIBILE solo con `settings.manage` — chiunque
 * deve poter atterrare qui. `GoogleWorkspacesSection`, invece, vuole
 * `integrations.manage` (`GET /api/settings/google-workspaces` risponde 403
 * senza): la sezione dei Workspace si monta SOLO con quel permesso — non per
 * condizionare cosa si vede, ma perché montarla senza farebbe fallire la sua
 * `useSuspenseQuery` su una rotta che il server rifiuta.
 */
export function SettingsGooglePage() {
  // `/me` in suspense, non `useCan`: la decisione si prende UNA volta, prima
  // del primo render, così la sezione dei Workspace (che sospende a sua volta)
  // non compare a pagina già montata.
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const canManageWorkspaces = hasPermission(me, "integrations.manage");
  const canEditAdmission = hasPermission(me, "settings.manage");

  return (
    <div>
      {canManageWorkspaces && <GoogleWorkspacesSection />}
      <MailAdmissionSection canEdit={canEditAdmission} canSeeDomains={canManageWorkspaces} />
    </div>
  );
}
