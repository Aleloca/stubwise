import type { SshPublicKey } from "../../data/model";

// Lo script che chi gestisce il server incolla per collegare i due accessi
// SSH (area 8b). Contiene SOLO chiavi pubbliche (anti-obiettivo 3), non
// scarica né esegue nulla da fuori, e fa di `stubwise-read` un utente di
// sola lettura vera: niente gruppo `docker` (che equivale a root), niente
// `docker inspect` (mostra le variabili d'ambiente dei container, quindi i
// segreti), `sudo` solo sui comandi di lettura, con percorso assoluto e
// `NOEXEC` (un pager non può aprire una shell). `stubwise-fix` invece può
// fare tutto: lo usa solo la correzione da task, dopo un piano approvato.

/** I comandi che `stubwise-read` lancia con `sudo` (nelle regole: percorso assoluto). */
export const READ_SUDO_COMMANDS: readonly string[] = [
  "journalctl",
  "docker ps",
  "docker logs",
  "docker stats --no-stream",
  "systemctl status",
];

/** I comandi di lettura che non chiedono `sudo`. */
export const READ_PLAIN_COMMANDS: readonly string[] = ["df", "free", "ps", "uptime", "ss -tlnp"];

/** Le opzioni di `journalctl` che scrivono (ruotano o cancellano i log): negate anche con `sudo`. */
export const JOURNALCTL_WRITE_FLAGS: readonly string[] = [
  "--vacuum-size",
  "--vacuum-time",
  "--vacuum-files",
  "--rotate",
  "--flush",
  "--sync",
  "--relinquish-var",
  "--smart-relinquish-var",
  "--setup-keys",
  "--update-catalog",
];

const absolute = (cmd: string) => `/usr/bin/${cmd}`;

/** Le regole `sudo` di `stubwise-read`: i soli comandi di lettura, con qualunque argomento. */
function readSudoRules(): string[] {
  const allowed = READ_SUDO_COMMANDS.map((cmd) => `${absolute(cmd)} *`);
  const denied = JOURNALCTL_WRITE_FLAGS.map((flag) => `!${absolute("journalctl")} *${flag}*`);
  return [
    "Defaults:stubwise-read !requiretty",
    ...allowed.map((rule) => `stubwise-read ALL=(root) NOPASSWD:NOEXEC: ${rule}`),
    `stubwise-read ALL=(root) NOPASSWD: ${denied.join(", ")}`,
  ];
}

function authorizedKey(key: SshPublicKey, instanceAddress: string | null): string {
  const options = [
    ...(instanceAddress ? [`from="${instanceAddress}"`] : []),
    "no-port-forwarding,no-agent-forwarding,no-X11-forwarding",
  ].join(",");
  return `${options} ${key.publicKey}`;
}

function userBlock(user: string, key: SshPublicKey, instanceAddress: string | null): string {
  return [
    `id -u ${user} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${user}`,
    `install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh`,
    `cat > /home/${user}/.ssh/authorized_keys <<'KEY'`,
    authorizedKey(key, instanceAddress),
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
 * Lo script d'installazione dei due accessi di `serverCode`, da eseguire
 * come root sul server. `instanceAddress` (l'indirizzo da cui si collega
 * l'istanza), se noto, limita le due chiavi a quell'origine (`from=`).
 */
export function installScript(input: {
  serverCode: string;
  read: SshPublicKey;
  fix: SshPublicKey;
  instanceAddress: string | null;
}): string {
  const { serverCode, read, fix, instanceAddress } = input;
  return [
    "#!/bin/bash",
    `# Stubwise: accessi SSH di ${serverCode} (solo chiavi pubbliche).`,
    "# stubwise-read legge soltanto; stubwise-fix può fare tutto sul server.",
    "set -euo pipefail",
    "",
    "# stubwise-read: sola lettura, fuori dal gruppo docker.",
    userBlock("stubwise-read", read, instanceAddress),
    sudoersBlock("stubwise-read", readSudoRules()),
    "",
    "# stubwise-fix: può fare tutto sul server, usato solo dopo un piano approvato.",
    userBlock("stubwise-fix", fix, instanceAddress),
    sudoersBlock("stubwise-fix", ["stubwise-fix ALL=(ALL) NOPASSWD: ALL"]),
    "",
    `echo "Stubwise: accessi di ${serverCode} pronti."`,
    "",
  ].join("\n");
}

/** Lo script che toglie i due accessi di `serverCode` (dopo una revoca). */
export function removalScript(serverCode: string): string {
  return [
    "#!/bin/bash",
    `# Stubwise: rimozione degli accessi SSH di ${serverCode}.`,
    "set -uo pipefail",
    "rm -f /etc/sudoers.d/stubwise-read /etc/sudoers.d/stubwise-fix",
    "pkill -u stubwise-read || true",
    "pkill -u stubwise-fix || true",
    "userdel stubwise-read && rm -rf /home/stubwise-read",
    "userdel stubwise-fix && rm -rf /home/stubwise-fix",
    `echo "Stubwise: accessi di ${serverCode} rimossi."`,
    "",
  ].join("\n");
}
