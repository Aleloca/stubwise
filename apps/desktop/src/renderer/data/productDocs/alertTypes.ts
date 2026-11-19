import { registerAlertTypes } from "../../domain/alerts/catalog";

// Le notifiche della doc di prodotto nel catalogo degli avvisi (area 11,
// D-6 = b, decisione del maintainer del 19 nov 2026): Preferenze → Notifiche
// le elenca nella famiglia Docs, e si spengono per progetto. Sono `addressed`:
// i destinatari li nomina il produttore (le menzioni, `productDocRecipients`)
// e l'iscrizione li filtra, accesa di default per loro. Ci si iscrive
// vedendo il progetto (`member`): chi non legge più i Docs riceve ancora la
// card, senza titolo né codice (`objectGone`, 11a). Il Telefono parte acceso
// solo per una menzione, che è rivolta a chi la riceve. Il server li avrà coi
// suoi `notification_kind`; fino ad allora le righe sono del prototipo.

const row = (type: string, defaultPhone: boolean) => ({
  type,
  group: "docs" as const,
  labelKey: `alerts.types.${type.replace(/\./g, "_")}`,
  subscribe: { perm: "member" as const },
  defaultOn: "members" as const,
  defaultPhone,
  mandatory: [],
  addressed: true,
});

registerAlertTypes([
  row("product_doc.mention", true),
  row("product_doc.updated", false),
  row("product_doc.question", false),
]);
