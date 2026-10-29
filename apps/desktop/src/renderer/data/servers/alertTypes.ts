import { ALERT_TYPES, registerAlertTypes, type AlertType } from "../../domain/alerts/catalog";
import type { Permission } from "../viewer";

// Gli avvisi dei server nel catalogo dell'8a (area 8b). Si registrano AL
// CARICAMENTO di questo modulo, che `data/servers/index.ts` importa
// staticamente: la fotografia del catalogo (`resetAlertTypes`) si scatta al
// primo `resetApi`, quindi un tipo registrato dopo sparirebbe al reset.
//
// Li può ricevere ogni membro del progetto (la sezione Servers la vede ogni
// membro); di partenza sono accesi per chi può operare sui server
// (`servers.operate`), che è anche chi può avviare una correzione, e per
// ogni full admin, membro del progetto o no (R-L10). Claude
// non li riceve mai (R-K5): lo esclude la lettura (`canReceive`).
//
// Scelta del piano: `monitor.alert` e `monitor.recovered` (i kind di prima,
// stesso significato) confluiscono nella riga di `server.trouble` (shape
// [A 10]): una riga sola nelle Preferenze, ognuno col suo default — tutti i
// membri, come prima — così il passaggio non cambia ciò che ognuno riceve.

const operates = (perms: (p: Permission) => boolean) => perms("servers.operate");

const label = (type: string) => `alerts.types.${type.replace(/\./g, "_")}`;

function serverRow(type: string, defaultPhone: boolean, extra: Partial<AlertType> = {}): AlertType {
  return {
    type,
    group: "monitor",
    labelKey: label(type),
    subscribe: { perm: "member" },
    defaultOn: operates,
    defaultForFullAdmins: true,
    defaultPhone,
    mandatory: [],
    ...extra,
  };
}

/** Un tipo di prima ri-registrato identico, ma nella riga di `server.trouble`. */
function joined(type: string): AlertType {
  const before = ALERT_TYPES.find((t) => t.type === type);
  if (!before) throw new Error(`alert type missing: ${type}`);
  return { ...before, sameRowAs: "server.trouble" };
}

export const SERVER_ALERT_TYPES: AlertType[] = [
  serverRow("server.trouble", true),
  serverRow("server.down", true, { sameRowAs: "server.trouble" }),
  serverRow("server.recovered", false, { sameRowAs: "server.trouble" }),
  serverRow("server.diagnosis_ready", true),
  joined("monitor.alert"),
  joined("monitor.recovered"),
];

registerAlertTypes(SERVER_ALERT_TYPES);
