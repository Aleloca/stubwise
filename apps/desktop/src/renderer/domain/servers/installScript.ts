import type { SshPublicKey } from "../../data/model";

// Lo script che chi gestisce il server incolla per collegare i due accessi
// SSH (area 8b). Contiene SOLO chiavi pubbliche (anti-obiettivo 3), non
// scarica né esegue nulla da fuori, e fa di `stubwise-read` un utente di
// sola lettura vera:
// - niente gruppo `docker` (equivale a root): i gruppi supplementari di
//   `stubwise-read` sono riscritti a `systemd-journal` e basta, così anche un
//   utente che esisteva già perde ogni gruppo di prima;
// - il journal si legge col gruppo `systemd-journal`, non con `sudo`
//   (R-L5): legge e non può ruotare né cancellare. Per lo stesso motivo
//   `systemctl status` gira senza `sudo` (le righe di log le vede col
//   gruppo), e un pager non gira mai come root;
// - `sudo` solo per i comandi `docker` di lettura, con percorso assoluto e
//   `NOEXEC`; niente `docker inspect` (mostra le variabili d'ambiente dei
//   container, quindi i segreti).
// `stubwise-fix` invece può fare tutto: lo usa solo la correzione da task,
// dopo un piano approvato.

/** I comandi che `stubwise-read` lancia con `sudo` (nelle regole: percorso assoluto). */
export const READ_SUDO_COMMANDS: readonly string[] = [
  "docker ps",
  "docker logs",
  "docker stats --no-stream",
];

/** I comandi di lettura che non chiedono `sudo` (`journalctl` col gruppo `systemd-journal`). */
export const READ_PLAIN_COMMANDS: readonly string[] = [
  "df",
  "free",
  "ps",
  "uptime",
  "ss -tlnp",
  "journalctl",
  "systemctl status",
];

/** Il solo gruppo supplementare di `stubwise-read`: legge il journal. */
export const READ_GROUP = "systemd-journal";

const absolute = (cmd: string) => `/usr/bin/${cmd}`;

/** Le regole `sudo` di `stubwise-read`: i soli comandi `docker` di lettura. */
function readSudoRules(): string[] {
  return [
    "Defaults:stubwise-read !requiretty",
    ...READ_SUDO_COMMANDS.map(
      (cmd) => `stubwise-read ALL=(root) NOPASSWD:NOEXEC: ${absolute(cmd)} *`,
    ),
  ];
}

function authorizedKey(key: SshPublicKey, instanceAddress: string | null): string {
  const options = [
    ...(instanceAddress ? [`from="${instanceAddress}"`] : []),
    "no-port-forwarding,no-agent-forwarding,no-X11-forwarding",
  ].join(",");
  return `${options} ${key.publicKey}`;
}

function userBlock(
  user: string,
  keys: SshPublicKey[],
  instanceAddress: string | null,
  groups: string,
): string {
  return [
    `id -u ${user} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${user}`,
    // `-G` senza `-a` RIMPIAZZA i gruppi supplementari: un utente che esisteva
    // già non si porta dietro un gruppo di prima (vuoto = nessuno).
    `usermod -G "${groups}" ${user}`,
    `install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh`,
    `cat > /home/${user}/.ssh/authorized_keys <<'KEY'`,
    ...keys.map((key) => authorizedKey(key, instanceAddress)),
    "KEY",
    `chown ${user}:${user} /home/${user}/.ssh/authorized_keys`,
    `chmod 600 /home/${user}/.ssh/authorized_keys`,
  ].join("\n");
}

function sudoersBlock(user: string, rules: string[]): string {
  const target = `/etc/sudoers.d/${user}`;
  return [
    `cat > ${target}.new <<'SUDO'`,
    ...rules,
    "SUDO",
    `visudo -cf ${target}.new`,
    `install -m 440 ${target}.new ${target}`,
    `rm -f ${target}.new`,
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
    read: string;
    fix: string;
    ready: (code: string) => string;
    removalTitle: (code: string) => string;
    removed: (code: string) => string;
  }
> = {
  en: {
    title: (code) => `# Stubwise: SSH accesses for ${code} (public keys only).`,
    who: "# stubwise-read only reads; stubwise-fix can do anything on the server.",
    read: `# stubwise-read: read-only; its only group is ${READ_GROUP} (it reads the journal).`,
    fix: "# stubwise-fix: can do anything on the server, used only after an approved plan.",
    ready: (code) => `echo "Stubwise: ${code} accesses ready."`,
    removalTitle: (code) => `# Stubwise: removing the SSH accesses of ${code}.`,
    removed: (code) => `echo "Stubwise: ${code} accesses removed."`,
  },
  it: {
    title: (code) => `# Stubwise: accessi SSH di ${code} (solo chiavi pubbliche).`,
    who: "# stubwise-read legge soltanto; stubwise-fix può fare tutto sul server.",
    read: `# stubwise-read: sola lettura; il suo unico gruppo è ${READ_GROUP} (legge il journal).`,
    fix: "# stubwise-fix: può fare tutto sul server, usato solo dopo un piano approvato.",
    ready: (code) => `echo "Stubwise: accessi di ${code} pronti."`,
    removalTitle: (code) => `# Stubwise: rimozione degli accessi SSH di ${code}.`,
    removed: (code) => `echo "Stubwise: accessi di ${code} rimossi."`,
  },
};

/**
 * Lo script d'installazione dei due accessi di `serverCode`, da eseguire
 * come root sul server. `instanceAddress` (l'indirizzo da cui si collega
 * l'istanza), se noto, limita le due chiavi a quell'origine (`from=`).
 *
 * `previous` (R-L8): durante una rigenerazione, le chiavi ancora in uso.
 * `authorized_keys` si RISCRIVE, quindi ogni utente riceve la vecchia E la
 * nuova: incollare il comando non toglie le chiavi che restano valide
 * finché la verifica delle nuove non riesce. Dopo, Stubwise distrugge le
 * vecchie private; la vecchia pubblica rimasta sul server è innocua, e il
 * comando successivo (una nuova rigenerazione) non la riscrive più.
 */
export function installScript(input: {
  serverCode: string;
  read: SshPublicKey;
  fix: SshPublicKey;
  previous?: { read: SshPublicKey; fix: SshPublicKey } | null;
  instanceAddress: string | null;
  lang?: ScriptLang;
}): string {
  const { serverCode, read, fix, previous, instanceAddress } = input;
  const text = TEXTS[input.lang ?? "en"];
  const keysOf = (kind: "read" | "fix", key: SshPublicKey) =>
    previous ? [previous[kind], key] : [key];
  return [
    "#!/bin/bash",
    text.title(serverCode),
    text.who,
    "set -euo pipefail",
    "",
    text.read,
    userBlock("stubwise-read", keysOf("read", read), instanceAddress, READ_GROUP),
    sudoersBlock("stubwise-read", readSudoRules()),
    "",
    text.fix,
    userBlock("stubwise-fix", keysOf("fix", fix), instanceAddress, ""),
    sudoersBlock("stubwise-fix", ["stubwise-fix ALL=(ALL) NOPASSWD: ALL"]),
    "",
    text.ready(serverCode),
    "",
  ].join("\n");
}

/** Lo script che toglie i due accessi di `serverCode` (dopo una revoca). */
export function removalScript(serverCode: string, lang: ScriptLang = "en"): string {
  const text = TEXTS[lang];
  return [
    "#!/bin/bash",
    text.removalTitle(serverCode),
    "set -uo pipefail",
    "rm -f /etc/sudoers.d/stubwise-read /etc/sudoers.d/stubwise-fix",
    "pkill -u stubwise-read || true",
    "pkill -u stubwise-fix || true",
    "userdel stubwise-read && rm -rf /home/stubwise-read",
    "userdel stubwise-fix && rm -rf /home/stubwise-fix",
    text.removed(serverCode),
    "",
  ].join("\n");
}
