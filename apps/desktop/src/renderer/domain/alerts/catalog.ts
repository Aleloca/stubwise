import {
  ALERT_TYPES as SHARED_ALERT_TYPES,
  defaultApplies as sharedDefaultApplies,
  type AlertType as SharedAlertType,
} from "@stubwise/shared";
import type { Permission } from "../../data/viewing";

// Il catalogo dei tipi di avviso (area 8a, spec «Notifiche: iscrizioni per
// progetto»). Dalla F2 dell'integrazione (R1) le righe stanno in
// `@stubwise/shared` (`alerts/catalog.ts`), lo stesso catalogo che legge il
// server: qui ne resta una copia MUTABILE, perché `registerAlertTypes` è
// ancora il punto d'estensione dei test. Il default di partenza è un dato
// (`defaultOn`, letto con `ruleApplies`); il prototipo non legge
// `appDefaultOn`, che vale solo per la build app (M-1 = a): qui i
// `monitor.*` restano accesi per ogni membro. Fuori dal catalogo, e quindi
// coi destinatari fissi: `security.alert`, le decisioni
// (`DECISION_NOTIFICATION_KINDS`), Chat e Automazioni.

export { ALERT_GROUPS, type AlertGroup } from "@stubwise/shared";

// Il catalogo condiviso nomina i permessi come stringhe: ci sono quelli del
// registro (di progetto, e `monitor.manage` d'istanza) e quelli che per ora
// vivono solo nel prototipo (`support.reply`, `servers.operate`). Qui si
// restringono a `Permission` in UN posto; un test verifica che ogni permesso
// del catalogo sia uno che il prototipo conosce.
export type DefaultRule = "off" | "members" | { perm: Permission };

export interface AlertType extends Omit<
  SharedAlertType,
  "subscribe" | "defaultOn" | "appDefaultOn"
> {
  subscribe: { perm: Permission | "member" };
  defaultOn: DefaultRule;
  appDefaultOn?: DefaultRule;
}

/** Se il default di partenza vale per chi ha questi permessi nel progetto. */
export const ruleApplies = (rule: DefaultRule, perms: (p: Permission) => boolean): boolean =>
  sharedDefaultApplies(rule, (p) => perms(p as Permission));

/** I tipi del catalogo, nell'ordine in cui si mostrano dentro la famiglia. */
export const ALERT_TYPES: AlertType[] = [...(SHARED_ALERT_TYPES as readonly AlertType[])];

/**
 * Il catalogo «di partenza»: i tipi qui sopra più quelli registrati al
 * caricamento dei moduli (8b), fotografato al primo `resetAlertTypes`.
 */
let baseline: AlertType[] | null = null;

/**
 * Rimette il catalogo com'era al caricamento: la prima chiamata (il primo
 * `resetApi`, dopo gli import) lo fotografa, le successive tolgono ciò che
 * è stato registrato dopo (le righe di prova dei test). Lo chiama `resetApi`.
 */
export function resetAlertTypes(): void {
  if (baseline === null) baseline = [...ALERT_TYPES];
  else ALERT_TYPES.splice(0, ALERT_TYPES.length, ...baseline);
}

/**
 * Il punto d'estensione delle aree successive (8b): aggiunge i tipi, o
 * sostituisce quelli con lo stesso `type`. Va chiamato al caricamento di un
 * modulo importato STATICAMENTE dal livello dati (`data/…`), mai da una
 * pagina o da un import dinamico: la fotografia del catalogo si scatta al
 * primo `resetApi`, non a fine caricamento. Quindi un tipo registrato dopo
 * il primo reset (una pagina caricata in lazy) sparirebbe al reset
 * successivo, e una registrazione di prova fatta prima del primo reset di un
 * file di test resterebbe nel catalogo per tutto quel file.
 */
export function registerAlertTypes(rows: AlertType[]): void {
  for (const r of rows) {
    const i = ALERT_TYPES.findIndex((t) => t.type === r.type);
    if (i >= 0) ALERT_TYPES[i] = r;
    else ALERT_TYPES.push(r);
  }
}

export const alertTypeOf = (kind: string): AlertType | undefined =>
  ALERT_TYPES.find((t) => t.type === kind);

export const isCatalogKind = (kind: string): boolean => alertTypeOf(kind) !== undefined;

/** Il tipo che fa da riga per `kind` nelle Preferenze (se stesso, o quello di `sameRowAs`). */
export const rowTypeOf = (kind: string): string => alertTypeOf(kind)?.sameRowAs ?? kind;

/** I tipi di una riga delle Preferenze: quello della riga, poi i kind di prima che vi confluiscono. */
export function rowPartners(rowType: string): AlertType[] {
  const main = alertTypeOf(rowType);
  if (!main) return [];
  return [main, ...ALERT_TYPES.filter((t) => t.sameRowAs === rowType)];
}
