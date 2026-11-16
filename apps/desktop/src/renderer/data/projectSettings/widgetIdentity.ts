import { forgetSecret, secretIdsOf, storeSecret } from "../admin/secrets";

// Il segreto d'identità dei clienti di un widget (API per i siti, S6), un
// segreto del progetto come la chiave d'ingestione: per questo vive qui e
// non in `data/support` (`architecture.secrets.test.ts`: `admin/secrets` lo
// importano solo admin, me, auth, instance e projectSettings). Rigenerarlo
// spegne il vecchio SUBITO; il valore nuovo esce solo da qui, una volta.

/** Un segreto nuovo per il widget; quello di prima smette di valere. */
export function rotateWidgetIdentitySecret(widgetId: string): string {
  for (const old of secretIdsOf("widget_identity_secret", widgetId)) forgetSecret(old);
  return storeSecret("widget_identity_secret", widgetId).value;
}
