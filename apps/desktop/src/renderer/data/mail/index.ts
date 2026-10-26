// La Posta (area 6) come la espone `api.ts`: `api.mail.<funzione>`. Chi vede
// che cosa lo decide `canSeeMessage` (visibility.ts), per letture e
// scritture: solo i destinatari, admin compresi. Le proposte condivise
// (`proposals.ts`) seguono `canSeeMailProposal`, nello stesso file.
export {
  getMailThread,
  listImportantMail,
  listMailboxes,
  listMailThreads,
  searchMail,
} from "./reads";
export {
  mailClassificationHistory,
  markRead,
  markUnread,
  reproposeMessage,
  setProposalsEnabled,
  simulateReply,
  syncMailbox,
  whenMailIdle,
  whenMailSynced,
} from "./writes";
export {
  chooseProjectFor,
  confirmMailProposal,
  getMailProposal,
  handMailProposal,
  ignoreMailProposal,
  listMailDecisions,
  listMailProposals,
  reassignMailProposal,
  type ConfirmMailProposalInput,
  type MailProposalOutcome,
} from "./proposals";
export { permissionForAction } from "./visibility";
export {
  attachDriveFile,
  discardDraft,
  getDraft,
  listDrafts,
  MAIL_MAX_ATTACHMENTS,
  MAIL_MAX_BYTES,
  MAIL_UNDO_MS,
  saveDraft,
  streamClaudeDraft,
  suggestRecipients,
  type ClaudeDraftOutcome,
  type ClaudeDraftStream,
  type MailDraftInput,
} from "./compose";
export {
  deleteFailedSend,
  restoreDiscardedDraft,
  retrySend,
  sendDraft,
  undoSend,
  whenSendSettled,
} from "./send";
export { getMeetingSummary, tasksBornFrom } from "./transcripts";
