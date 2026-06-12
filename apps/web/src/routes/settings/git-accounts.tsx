import { GitAccountsSection } from "../../components/git-accounts-section";

/**
 * Sotto-pagina Account Git (solo admin): elenco e gestione degli account git
 * riutilizzabili. La logica vive in GitAccountsSection, riusata così com'è.
 */
export function SettingsGitAccountsPage() {
  return <GitAccountsSection />;
}
