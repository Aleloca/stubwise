import type { EnvironmentInput } from "../../data/releases";

// La modifica di un ambiente (review F4a, I2): solo ciò che è cambiato. I
// collegamenti ai server si mandano solo se cambiano davvero: rimandarli
// farebbe rifare al server ogni collegamento (stendendo di nuovo il server di
// tutto il progetto) e fermerebbe una semplice ridenominazione su un server
// che chi scrive non vede.

const key = (s: EnvironmentInput["servers"][number]) =>
  `${s.repositoryId ?? "*"}=${s.serverCode.trim().toUpperCase()}`;

const sameServers = (a: EnvironmentInput["servers"], b: EnvironmentInput["servers"]) => {
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
};

export function environmentPatch(
  before: EnvironmentInput,
  after: EnvironmentInput,
): Partial<EnvironmentInput> {
  return {
    ...(after.name !== before.name ? { name: after.name } : {}),
    ...(after.kind !== before.kind ? { kind: after.kind } : {}),
    ...(after.url !== before.url ? { url: after.url } : {}),
    ...(sameServers(before.servers, after.servers) ? {} : { servers: after.servers }),
  };
}
