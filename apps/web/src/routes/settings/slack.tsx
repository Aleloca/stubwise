import { SlackSection } from "../../components/slack-section";

/**
 * Sotto-pagina Slack (solo admin): credenziali Slack (signing secret + bot
 * token) per l'ingestion via slash command e interazioni. La logica vive in
 * SlackSection.
 */
export function SettingsSlackPage() {
  return <SlackSection />;
}
