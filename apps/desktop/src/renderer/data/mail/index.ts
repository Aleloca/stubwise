// La Posta (area 6) come la espone `api.ts`: `api.mail.<funzione>`. Chi vede
// che cosa lo decide `canSeeMessage` (visibility.ts), per letture e
// scritture: solo i destinatari, admin compresi.
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
  reproposeMessage,
  setProposalsEnabled,
  syncMailbox,
  whenMailIdle,
} from "./writes";
