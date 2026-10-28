// Support (area 8a) come lo espone `api.ts`: `api.support.<funzione>`. Chi
// vede che cosa e gli stati derivati li decide `visibility.ts`. Nessuna
// funzione manda un'email al cliente né crea una richiesta da un'email (lo
// verifica un test sull'insieme esportato). `simulate.ts` esiste solo nel
// prototipo.

export {
  customerPreview,
  getSupportConversation,
  listSupportConversations,
  listWaitingCustomers,
  listWidgets,
  myRequestStatus,
  searchSupport,
  type CustomerPreview,
  type MyRequestStatus,
  type SupportSearchResult,
  type SupportWidgetView,
  type WidgetList,
} from "./reads";
export {
  createWidget,
  deleteWidget,
  draftReply,
  emailDraftFor,
  followConversation,
  openRequestFrom,
  replyToCustomer,
  updateWidget,
  type WidgetInput,
} from "./writes";
export { simulateCustomerLeaves, simulateCustomerMessage, simulateTriageDone } from "./simulate";
export type { SupportConversationView, SupportRequestView } from "./visibility";
export type { SupportState } from "../../domain/support/state";
