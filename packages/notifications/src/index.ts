export {
  buildTestEvent,
  dispatchNotification,
  formatEvent,
  loadSettings,
  sendTest,
  sendWebhookEvent,
  shouldSendWebhook,
  type DbOrTx,
  type DispatchOptions,
  type NotificationSettingsRow,
  type SendTestResult,
} from "./dispatch.js";

export { publishNotification, type PublishOpts } from "./publish.js";

export {
  actionsFor,
  actorAllows,
  kindOffers,
  openUrl,
  stateAllows,
  IN_FLIGHT_JOB_STATUSES,
  KINDS_WITH_OPTIONS,
  SNOOZE_OPTIONS,
  type ActionActor,
  type ActionId,
  type ActionableNotification,
  type ActorRole,
  type SnoozeUntil,
} from "./actions.js";

export {
  ANSWER_FREE_ACTION_ID,
  answerActionId,
  buildInboxBlocks,
  buildQuestionBlocks,
  inboxBlockId,
  parseInboxBlockId,
  type InboxBlocksInput,
  type QuestionBlocksInput,
  type SlackBlock,
} from "./slack-blocks.js";

export {
  createSlackClient,
  isFatalSlackError,
  loadSlackBotToken,
  loadSlackCreds,
  SlackApiError,
  type FetchImpl,
  type PostMessageInput,
  type PostedMessage,
  type SlackClient,
  type SlackClientFactory,
  type SlackCreds,
  type SlackMessenger,
  type SlackUserProfileResult,
  type SlackWorkspaceUser,
  type UpdateMessageInput,
} from "./slack-client.js";

export {
  audienceFor,
  recipientsFor,
  type Audience,
  type RoutingContext,
} from "./routing.js";

// --- push (Fase 4) ---
//
// NON sono nell'entry `./pure`: a costruire un payload e a parlare col relay è
// il WORKER, non un client. Il mobile riceve le push, non le manda.
export {
  buildPushPayload,
  PUSH_TITLE_KEY,
  type PushPayloadContext,
} from "./push/payload.js";

export {
  createPushRelayClient,
  PushRelayRejected,
  PushRelayUnavailable,
  type PushRelayClient,
  type PushRelayClientOptions,
} from "./push/relay-client.js";

export {
  DEFAULT_PUSH_RELAY_URL,
  loadPushConfig,
  type PushConfig,
} from "./push/config.js";

export {
  escapeSlackMrkdwn,
  formatNotification,
  formatNotificationText,
  sampleEvents,
  type AgentQuestionOption,
  type DocsLimitPausedEvent,
  type FormattedNotification,
  type JobAwaitingInputEvent,
  type JobFailedEvent,
  type JobHeldEvent,
  type JobPlanReviewEvent,
  type MonitorAlertEvent,
  type MonitorCondition,
  type MonitorRecoveredEvent,
  type NotificationEvent,
  type NotificationFormat,
  type NotificationKind,
  type PrOpenedEvent,
  type ProjectPulseEvent,
  type PulseProposal,
  type PulseUrgency,
  type TicketCreatedEvent,
} from "./format.js";
