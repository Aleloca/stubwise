/**
 * `@stubwise/google` — client HTTP di Google (OAuth, Gmail, Calendar),
 * condiviso da `apps/server` (flusso OAuth delle caselle) e da `apps/worker`
 * (poller della posta e del calendario), che non può importare dal server.
 *
 * È un client PURO: `fetch` iniettabile, nessuna dipendenza dal DB, nessuno
 * stato. Chi ha bisogno del refresh token decifrato lo carica da sé — l'helper
 * che parla col DB vive fuori da questo livello.
 */
export {
  FATAL_GOOGLE_CODES,
  GoogleApiError,
  isFatalGoogleError,
  type GoogleApiErrorInit,
} from "./errors.js";

export {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  parseGoogleJson,
  parseRetryAfterMs,
  requestGoogle,
  type FetchImpl,
  type GoogleClientOptions,
  type GoogleRequestSpec,
  type QueryValue,
} from "./fetch.js";

export {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  refreshAccessToken,
  revokeToken,
  type AuthorizeUrlInput,
  type ExchangeCodeInput,
  type GoogleTokens,
  type GoogleUserinfo,
  type RefreshTokenInput,
} from "./oauth.js";

export {
  capText,
  decodeBase64Url,
  DEFAULT_METADATA_HEADERS,
  extractText,
  getMessageFull,
  getMessageMetadata,
  GMAIL_API_BASE,
  htmlToText,
  listHistory,
  listMessages,
  MAX_TEXT_LENGTH,
  stripQuotedAndSignature,
  TEXT_TRUNCATION_MARKER,
  type ExtractTextOptions,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessagesPage,
  type GmailPayload,
  type ListHistoryInput,
  type ListMessagesInput,
} from "./gmail.js";

export {
  CALENDAR_API_BASE,
  listEvents,
  type CalendarEventsPage,
  type GoogleCalendarEvent,
  type ListEventsInput,
} from "./calendar.js";
