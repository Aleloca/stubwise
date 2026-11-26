import { registerAlertTypes } from "../../domain/alerts/catalog";

// Le notifiche della doc di prodotto nel catalogo degli avvisi (area 11,
// D-6 = b, maintainer 19 nov 2026), con N-1 = a (maintainer, 20 nov 2026):
// - `product_doc.mention` arriva SEMPRE a chi è menzionato (obbligo
//   `mentioned`): solo obbligatoria, nessuna riga da spegnere; anche a chi
//   nel frattempo non legge più i Docs, come card senza titolo né codice
//   (`objectGone`, 11a);
// - `product_doc.updated` e `.question` hanno la riga del progetto in
//   Preferenze → Notifiche, che decide per tutte le pagine: ci si iscrive
//   leggendo i Docs (`docs.view`), accesa di partenza per chi ha `docs.edit`;
//   chi segue la pagina le riceve SEMPRE, anche con la riga spenta (obbligo
//   `follower`).
// Il Telefono parte acceso solo per una menzione. Le righe sono del
// prototipo finché F2 di 72 non le porta nel catalogo condiviso.

const docsRow = (type: string) => ({
  type,
  group: "docs" as const,
  labelKey: `alerts.types.${type.replace(/\./g, "_")}`,
  subscribe: { perm: "docs.view" as const },
  defaultOn: { perm: "docs.edit" as const },
  defaultPhone: false,
  mandatory: ["follower" as const],
});

registerAlertTypes([
  {
    type: "product_doc.mention",
    group: "docs",
    labelKey: "alerts.types.product_doc_mention",
    // Chi è menzionato e non legge più i Docs riceve ancora la card, senza
    // titolo né codice (`objectGone`, 11a).
    subscribe: { perm: "member" },
    defaultOn: "off",
    defaultPhone: true,
    mandatory: ["mentioned"],
    mandatoryOnly: true,
  },
  docsRow("product_doc.updated"),
  docsRow("product_doc.question"),
]);
