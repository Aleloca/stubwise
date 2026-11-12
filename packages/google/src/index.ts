/**
 * `@stubwise/google` — client HTTP di Google (OAuth, Gmail, Calendar),
 * condiviso da `apps/server` (flusso OAuth delle caselle) e da `apps/worker`
 * (poller della posta e del calendario), che non può importare dal server.
 *
 * È un client PURO: `fetch` iniettabile, nessuna dipendenza dal DB, nessuno
 * stato. **Questo entrypoint non importa nulla che tocchi il database, e va
 * tenuto così.** L'unica funzione che legge il DB — `loadGoogleAccountCredentials`,
 * che decifra il refresh token di una casella e le credenziali OAuth del suo
 * Workspace — vive nel subpath `@stubwise/google/credentials`, apposta: chi
 * importa il client non si tira dietro Drizzle, e la purezza del core resta
 * verificabile leggendo gli `import` di questo file.
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
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  missingGoogleScopes,
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
  extractRawBody,
  extractText,
  getMessageFull,
  getMessageMetadata,
  getThreadFull,
  GMAIL_API_BASE,
  GMAIL_UNREAD_LABEL,
  htmlToText,
  listAttachments,
  listHistory,
  listMessages,
  MAX_TEXT_LENGTH,
  modifyThread,
  sanitizeEmailHtml,
  stripQuotedAndSignature,
  TEXT_TRUNCATION_MARKER,
  type ExtractTextOptions,
  type GmailAttachment,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessagesPage,
  type GmailPayload,
  type ListHistoryInput,
  type ListMessagesInput,
} from "./gmail.js";

export {
  CALENDAR_API_BASE,
  getEvent,
  listEvents,
  parseCalendarEvent,
  type CalendarEventsPage,
  type GetEventInput,
  type GoogleCalendarEvent,
  type GoogleParentEvent,
  type ListEventsInput,
} from "./calendar.js";
// Area 6, F3: scrivere (MIME e bozze di Gmail).
export {
  buildMimeMessage,
  createDraft,
  deleteDraft,
  encodeRaw,
  getDraft,
  getSendAsSignature,
  sendDraft,
  updateDraft,
  type GmailDraftRef,
  type MailAddressInput,
  type MimeAttachment,
  type MimeInput,
} from "./gmail-compose.js";
// Area 6, F4: scrivere sul calendario.
export {
  deleteCalendarEvent,
  getCalendarEvent,
  insertCalendarEvent,
  listEventInstances,
  patchCalendarEvent,
  respondToCalendarEvent,
  type CalendarEventPatch,
  type CalendarGuest,
  type CalendarReminders,
  type NewCalendarEvent,
} from "./calendar-write.js";
