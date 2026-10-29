import { describe, expect, it } from "vitest";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { installScript, READ_SUDO_COMMANDS, removalScript } from "./installScript";

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

  it("`from=` c'è solo quando l'indirizzo dell'istanza è noto", () => {
    expect(script(null)).not.toContain("from=");
    const s = script("203.0.113.7");
    expect(s).toContain('from="203.0.113.7"');
    // Su entrambe le chiavi.
    expect(s.match(/from="203\.0\.113\.7"/g)).toHaveLength(2);
  });

  it("stubwise-read non entra nel gruppo docker e non ha docker inspect", () => {
    for (const s of [script(null), script("203.0.113.7")]) {
      expect(s).not.toMatch(/usermod[^\n]*-a?G[^\n]*docker/);
      expect(s).not.toMatch(/gpasswd[^\n]*docker/);
      expect(s).not.toMatch(/adduser[^\n]*docker/);
      expect(s).not.toContain("docker inspect");
    }
  });

  it("non scarica né esegue niente da fuori e non contiene chiavi private", () => {
    const s = script("203.0.113.7");
    expect(s).not.toMatch(/\bcurl\b/);
    expect(s).not.toMatch(/\bwget\b/);
    expect(s).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(s).not.toContain("PRIVATE KEY");
  });

  it("le regole sudo di stubwise-read sono i soli comandi di lettura, con percorsi assoluti", () => {
    const s = script(null);
    const readRules = s.split("\n").filter((l) => l.startsWith("stubwise-read "));
    expect(readRules.length).toBeGreaterThan(0);
    for (const rule of readRules) {
      expect(rule).not.toContain("NOPASSWD: ALL");
      expect(rule).not.toMatch(/=\(ALL\)\s+NOPASSWD:\s*ALL/);
    }
    const sudoBlock = readRules.join("\n");
    for (const cmd of READ_SUDO_COMMANDS) {
      const [bin, ...rest] = cmd.split(" ");
      expect(sudoBlock).toContain(`/usr/bin/${bin}${rest.length ? ` ${rest.join(" ")}` : ""}`);
    }
    // I comandi senza sudo non hanno una regola.
    for (const plain of ["df", "free", "uptime", " ps", "ss -tlnp"]) {
      expect(sudoBlock).not.toContain(`/usr/bin/${plain.trim()} `);
    }
    expect(READ_SUDO_COMMANDS).toEqual([
      "journalctl",
      "docker ps",
      "docker logs",
      "docker stats --no-stream",
      "systemctl status",
    ]);
  });

  it("valida i file sudoers prima di installarli", () => {
    expect(script(null)).toContain("visudo -cf");
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
