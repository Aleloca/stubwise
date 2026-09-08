import { useSuspenseQuery } from "@tanstack/react-query";
import { GoogleWorkspacesSection } from "../../components/google-workspaces-section";
import { MailAdmissionSection } from "../../components/mail-admission-section";
import { meQueryOptions } from "../../lib/auth";

/**
 * Sotto-pagina Google: il registro dei Google Workspace (le app OAuth interne
 * su cui gli operatori collegano le proprie caselle Gmail e Calendar, SOLO
 * admin) e, dalla fase 6c, la sezione «Posta ammessa» (decide SE un messaggio
 * entra nella pipeline, non a quale progetto va).
 *
 * ⚠️ La rotta `/settings/google` NON ha più `beforeLoad: requireAdmin` (vedi
 * router.tsx): il design della fase 6c chiede la sezione «Posta ammessa»
 * VISIBILE A TUTTI (lettura, `GET /api/settings/mail-admission` è aperta a
 * ogni utente autenticato) e SCRIVIBILE solo dagli admin — un member deve
 * poter atterrare qui. `GoogleWorkspacesSection`, invece, resta admin-only
 * per costruzione (`GET /api/settings/google-workspaces` risponde 403 a un
 * member): questo componente decide il ruolo UNA VOLTA (`meQueryOptions`,
 * stesso pattern di `SettingsLayout`/`SettingsAccountPage`) e la sezione dei
 * Workspace si monta SOLO per un admin — mai per condizionare cosa vede,
 * ma perché montarla per un member farebbe fallire la sua
 * `useSuspenseQuery` su una rotta che il server rifiuta.
 */
export function SettingsGooglePage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div>
      {isAdmin && <GoogleWorkspacesSection />}
      <MailAdmissionSection isAdmin={isAdmin} />
    </div>
  );
}
