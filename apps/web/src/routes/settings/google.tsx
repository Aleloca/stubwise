import { GoogleWorkspacesSection } from "../../components/google-workspaces-section";

/**
 * Sotto-pagina Google (solo admin): registro dei Google Workspace, cioè le app
 * OAuth interne su cui gli operatori collegano le proprie caselle Gmail e
 * Calendar. La logica vive in GoogleWorkspacesSection.
 */
export function SettingsGooglePage() {
  return <GoogleWorkspacesSection />;
}
