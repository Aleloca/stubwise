// Gli avvisi (area 8a) come li espone `api.ts`: `api.alerts.<funzione>`.
// Chi riceve che cosa lo decide `visibility.ts` col catalogo e il calcolo
// puri di `domain/alerts`; `publish.ts` è l'unico modo di creare un avviso
// del catalogo (lo usano `data/releases` e `data/support`, importandolo da
// lì: non è una funzione dell'API, le pagine non creano avvisi). Le aree
// successive aggiungono tipi con `registerAlertTypes` del catalogo.

export {
  subscriptionRows,
  type ProjectSubscriptions,
  type SubscriptionRow,
  type SubscriptionState,
} from "./reads";
export {
  copySubscriptions,
  muteFromNotification,
  muteProject,
  setSubscription,
  type Undoable,
} from "./writes";
