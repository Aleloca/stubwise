import type { SshPublicKey } from "../../data/model";
import { SSH_READ_USER } from "./sshAccess";

// Lo script che chi gestisce il server incolla per collegare l'accesso SSH
// (area 8, F4b, Q3 = b): UN utente, `stubwise-read`, di sola lettura vera.
// Contiene SOLO la chiave pubblica (anti-obiettivo 3), non scarica né
// esegue nulla da fuori, e:
// - niente `sudo`: nessuna regola, e quelle lasciate da prima si tolgono;
// - niente gruppo `docker` (il socket vale root): i gruppi supplementari
//   sono riscritti a `systemd-journal` e basta, così anche un utente che
//   esisteva già perde ogni gruppo di prima. Col gruppo legge il journal
//   (`journalctl -p err`, F4b-3), senza ruotarlo né cancellarlo;
// - la chiave entra con `restrict` (niente pty, inoltri, agent, X11).
// I log e lo stato dei container li legge l'AGENTE, e le correzioni passano
// da lui (mai dall'SSH): all'utente SSH non servono.

/** Il solo gruppo supplementare di `stubwise-read`: legge il journal. */
export const READ_GROUP = "systemd-journal";

/** La riga di `authorized_keys`: `restrict`, e `from=` se l'indirizzo dell'istanza è noto. */
export function authorizedKeysLine(key: SshPublicKey, instanceAddress: string | null): string {
  const options = ["restrict", ...(instanceAddress ? [`from="${instanceAddress}"`] : [])].join(",");
  return `${options} ${key.publicKey}`;
}

function userBlock(user: string, keys: SshPublicKey[], instanceAddress: string | null): string {
  return [
    `id -u ${user} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${user}`,
    // `-G` senza `-a` RIMPIAZZA i gruppi supplementari: un utente che esisteva
    // già non si porta dietro `sudo` o `docker`. `-g` rimette il primario al
    // gruppo omonimo: uno creato a mano con `-g docker` resterebbe altrimenti
    // nel gruppo docker (= root).
    `getent group ${user} >/dev/null || groupadd ${user}`,
    `usermod -g ${user} -G "${READ_GROUP}" ${user}`,
    `rm -f /etc/sudoers.d/${user}`,
    `install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh`,
    `cat > /home/${user}/.ssh/authorized_keys <<'KEY'`,
    ...keys.map((key) => authorizedKeysLine(key, instanceAddress)),
    "KEY",
    `chown ${user}:${user} /home/${user}/.ssh/authorized_keys`,
    `chmod 600 /home/${user}/.ssh/authorized_keys`,
  ].join("\n");
}

/**
 * La lingua dei commenti e degli `echo` dello script: quella dell'interfaccia
 * di chi lo legge (lo legge prima di eseguirlo). I comandi non cambiano.
 */
export type ScriptLang = "en" | "it";

const TEXTS: Record<
  ScriptLang,
  {
    title: (code: string) => string;
    who: string;
    ready: (code: string) => string;
    removalTitle: (code: string) => string;
    removed: (code: string) => string;
  }
> = {
  en: {
    title: (code) => `# Stubwise: read-only SSH access for ${code} (public key only).`,
    who: `# ${SSH_READ_USER} only reads: no sudo, no docker group; its only group is ${READ_GROUP} (it reads the journal). Container logs and fixes go through the monitoring agent.`,
    ready: (code) => `echo "Stubwise: ${code} read-only access ready."`,
    removalTitle: (code) => `# Stubwise: removing the read-only SSH access of ${code}.`,
    removed: (code) => `echo "Stubwise: ${code} access removed."`,
  },
  it: {
    title: (code) =>
      `# Stubwise: accesso SSH di sola lettura per ${code} (solo la chiave pubblica).`,
    who: `# ${SSH_READ_USER} legge soltanto: niente sudo, niente gruppo docker; il suo unico gruppo è ${READ_GROUP} (legge il journal). I log dei container e le correzioni passano dall'agente di monitoraggio.`,
    ready: (code) => `echo "Stubwise: accesso di sola lettura di ${code} pronto."`,
    removalTitle: (code) => `# Stubwise: rimozione dell'accesso SSH di sola lettura di ${code}.`,
    removed: (code) => `echo "Stubwise: accesso di ${code} rimosso."`,
  },
};

/**
 * Lo script d'installazione dell'accesso di `serverCode`, da eseguire come
 * root sul server. `instanceAddress` (l'indirizzo da cui si collega
 * l'istanza), se noto, limita la chiave a quell'origine (`from=`).
 *
 * `previous` (R-L8): durante una rigenerazione, la chiave ancora in uso.
 * `authorized_keys` si RISCRIVE, quindi riceve la vecchia E la nuova:
 * incollare il comando non toglie la chiave che resta valida finché la
 * verifica della nuova non riesce. Dopo, Stubwise distrugge la vecchia
 * privata; la vecchia pubblica rimasta sul server è innocua, e il comando
 * successivo non la riscrive più.
 */
export function installScript(input: {
  serverCode: string;
  key: SshPublicKey;
  previous?: SshPublicKey | null;
  instanceAddress: string | null;
  lang?: ScriptLang;
}): string {
  const { serverCode, key, previous, instanceAddress } = input;
  const text = TEXTS[input.lang ?? "en"];
  return [
    "#!/bin/bash",
    text.title(serverCode),
    text.who,
    "set -euo pipefail",
    "",
    userBlock(SSH_READ_USER, previous ? [previous, key] : [key], instanceAddress),
    "",
    text.ready(serverCode),
    "",
  ].join("\n");
}

/** Lo script che toglie l'accesso di `serverCode` (dopo una revoca). */
export function removalScript(serverCode: string, lang: ScriptLang = "en"): string {
  const text = TEXTS[lang];
  return [
    "#!/bin/bash",
    text.removalTitle(serverCode),
    "set -uo pipefail",
    `rm -f /etc/sudoers.d/${SSH_READ_USER}`,
    `pkill -u ${SSH_READ_USER} || true`,
    `userdel ${SSH_READ_USER} && rm -rf /home/${SSH_READ_USER}`,
    text.removed(serverCode),
    "",
  ].join("\n");
}
