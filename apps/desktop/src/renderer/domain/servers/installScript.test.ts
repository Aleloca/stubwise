import { describe, expect, it } from "vitest";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { installScript, READ_GROUP, READ_SUDO_COMMANDS, removalScript } from "./installScript";

const READ = fakeSshPublicKey("SRV-1", "read", 1, "2026-10-20T10:00:00Z");
const FIX = fakeSshPublicKey("SRV-1", "fix", 1, "2026-10-20T10:00:00Z");
const script = (instanceAddress: string | null) =>
  installScript({ serverCode: "SRV-1", read: READ, fix: FIX, instanceAddress });

describe("installScript (RF 3)", () => {
  it("crea i due utenti con le due chiavi pubbliche e le opzioni di authorized_keys", () => {
    const s = script(null);
    expect(s).toContain("useradd");
    expect(s).toContain("stubwise-read");
    expect(s).toContain("stubwise-fix");
    expect(s).toContain(READ.publicKey);
    expect(s).toContain(FIX.publicKey);
    expect(s).toContain("no-port-forwarding,no-agent-forwarding,no-X11-forwarding");
    expect(s).toContain("stubwise-fix ALL=(ALL) NOPASSWD: ALL");
  });

  it("R-L8: in rigenerazione autorizza la vecchia E la nuova chiave di ogni utente", () => {
    const NEW_READ = fakeSshPublicKey("SRV-1", "read", 2, "2026-10-28T10:00:00Z");
    const NEW_FIX = fakeSshPublicKey("SRV-1", "fix", 2, "2026-10-28T10:00:00Z");
    const s = installScript({
      serverCode: "SRV-1",
      read: NEW_READ,
      fix: NEW_FIX,
      previous: { read: READ, fix: FIX },
      instanceAddress: "203.0.113.7",
    });
    for (const k of [READ, FIX, NEW_READ, NEW_FIX]) expect(s).toContain(k.publicKey);
    // Ognuna nel file del SUO utente, con le restrizioni.
    const block = (user: string) =>
      s.split(`cat > /home/${user}/.ssh/authorized_keys <<'KEY'\n`)[1]!.split("\nKEY")[0]!;
    expect(block("stubwise-read").split("\n")).toEqual([
      expect.stringContaining(READ.publicKey),
      expect.stringContaining(NEW_READ.publicKey),
    ]);
    expect(block("stubwise-fix")).not.toContain(READ.publicKey);
    expect(s.match(/from="203\.0\.113\.7"/g)).toHaveLength(4);
    expect(s.match(/no-port-forwarding/g)).toHaveLength(4);
    // Senza `previous` una chiave sola per utente.
    expect(script(null).match(/no-port-forwarding/g)).toHaveLength(2);
  });

  it("`from=` c'è solo quando l'indirizzo dell'istanza è noto", () => {
    expect(script(null)).not.toContain("from=");
    const s = script("203.0.113.7");
    expect(s).toContain('from="203.0.113.7"');
    // Su entrambe le chiavi.
    expect(s.match(/from="203\.0\.113\.7"/g)).toHaveLength(2);
  });

  it("stubwise-read non entra nel gruppo docker e non ha docker inspect", () => {
    for (const s of [script(null), script("203.0.113.7")]) {
      expect(s).not.toMatch(/usermod[^\n]*docker/);
      expect(s).not.toMatch(/gpasswd[^\n]*docker/);
      expect(s).not.toMatch(/adduser[^\n]*docker/);
      expect(s).not.toMatch(/useradd[^\n]*-G/);
      expect(s).not.toContain("docker inspect");
    }
  });

  it("R-L5: i gruppi di stubwise-read sono RIMPIAZZATI dal solo systemd-journal", () => {
    expect(READ_GROUP).toBe("systemd-journal");
    const s = script(null);
    // `-G` senza `-a`: un utente che esisteva già perde i gruppi di prima (docker compreso).
    expect(s).toContain('usermod -G "systemd-journal" stubwise-read');
    expect(s).not.toMatch(/usermod[^\n]*-a/);
    // stubwise-fix non ha gruppi: fa tutto con sudo.
    expect(s).toContain('usermod -G "" stubwise-fix');
  });

  it("non scarica né esegue niente da fuori e non contiene chiavi private", () => {
    const s = script("203.0.113.7");
    expect(s).not.toMatch(/\bcurl\b/);
    expect(s).not.toMatch(/\bwget\b/);
    expect(s).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(s).not.toContain("PRIVATE KEY");
  });

  it("le regole sudo di stubwise-read sono i soli comandi docker di lettura, con percorsi assoluti", () => {
    expect(READ_SUDO_COMMANDS).toEqual(["docker ps", "docker logs", "docker stats --no-stream"]);
    const s = script(null);
    const readRules = s.split("\n").filter((l) => l.startsWith("stubwise-read "));
    expect(readRules).toEqual(
      READ_SUDO_COMMANDS.map(
        (cmd) => `stubwise-read ALL=(root) NOPASSWD:NOEXEC: /usr/bin/${cmd} *`,
      ),
    );
    // R-L5: journal e systemctl senza sudo (niente pager né negazioni come root).
    expect(s).not.toContain("journalctl");
    expect(s).not.toContain("systemctl");
    expect(s).not.toMatch(/!\/usr\/bin/);
  });

  it("valida i file sudoers prima di installarli", () => {
    expect(script(null)).toContain("visudo -cf");
  });
});

describe("la lingua dei commenti e degli echo", () => {
  const ITALIAN = /accessi|sola lettura|soltanto|può fare|pronti|rimoss|rimozione|gruppo/;
  it("in inglese (default) nessun commento è in italiano; in italiano sì", () => {
    expect(script(null)).not.toMatch(ITALIAN);
    expect(removalScript("SRV-1")).not.toMatch(ITALIAN);
    const it_ = installScript({
      serverCode: "SRV-1",
      read: READ,
      fix: FIX,
      instanceAddress: null,
      lang: "it",
    });
    expect(it_).toContain("# Stubwise: accessi SSH di SRV-1 (solo chiavi pubbliche).");
    expect(removalScript("SRV-1", "it")).toContain('echo "Stubwise: accessi di SRV-1 rimossi."');
  });

  it("i comandi sono gli stessi nelle due lingue: cambiano solo commenti ed echo", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("#") && !l.startsWith("echo "))
        .join("\n");
    const en = installScript({ serverCode: "SRV-1", read: READ, fix: FIX, instanceAddress: null });
    const it_ = installScript({
      serverCode: "SRV-1",
      read: READ,
      fix: FIX,
      instanceAddress: null,
      lang: "it",
    });
    expect(strip(en)).toBe(strip(it_));
    expect(strip(removalScript("SRV-1"))).toBe(strip(removalScript("SRV-1", "it")));
  });
});

describe("removalScript", () => {
  it("toglie i due utenti e le loro regole sudo", () => {
    const s = removalScript("SRV-1");
    expect(s).toContain("userdel stubwise-read");
    expect(s).toContain("userdel stubwise-fix");
    expect(s).toContain("/etc/sudoers.d/stubwise-read");
    expect(s).toContain("/etc/sudoers.d/stubwise-fix");
    expect(s).toContain("SRV-1");
    expect(s).not.toMatch(/\bcurl\b|\bwget\b/);
  });
});
