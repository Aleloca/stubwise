/**
 * Client delle Web API di Slack — RI-ESPORTO.
 *
 * L'implementazione vive in `@stubwise/notifications` (`src/slack-client.ts`):
 * ci è stata spostata quando il WORKER ha dovuto mandare i DM dell'inbox dal
 * poller delle consegne, e il worker non può importare da `apps/server`.
 *
 * Questo modulo resta come facciata perché le rotte Slack (`./routes.ts`,
 * `./identity-routes.ts`, `./creds.ts`) e i loro test lo importano da qui: gli
 * import esistenti continuano a valere, il codice sta in un posto solo.
 */
export {
  createSlackClient,
  isFatalSlackError,
  SlackApiError,
  type FetchImpl,
  type PostedMessage,
  type PostMessageInput,
  type SlackClient,
  type SlackMessenger,
  type SlackUserProfileResult,
  type SlackWorkspaceUser,
  type UpdateMessageInput,
} from "@stubwise/notifications";
