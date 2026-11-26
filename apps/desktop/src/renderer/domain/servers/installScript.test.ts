import { describe, expect, it } from "vitest";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { authorizedKeysLine, installScript, READ_GROUP, removalScript } from "./installScript";

// Lo script dell'accesso SSH di un server (area 8, F4b, Q3 = b): UN utente,
// `stubwise-read`, di sola lettura — senza `sudo`, senza il gruppo `docker`.

const KEY = fakeSshPublicKey("SRV-1", 1, "2026-10-20T10:00:00Z");
const script = (instanceAddress: string | null) =>
  installScript({ serverCode: "SRV-1", key: KEY, instanceAddress });

describe("installScript", () => {
  it("crea il solo utente di lettura con la chiave pubblica, la riga con `restrict`", () => {
    const s = script(null);
    expect(s).toContain("useradd");
    expect(s).toContain("stubwise-read");
    expect(s).not.toContain("stubwise-fix");
    expect(s).toContain(`restrict ${KEY.publicKey}`);
    expect(s.match(/ssh-ed25519/g)).toHaveLength(1);
  });

  it("nessun sudo: nessuna regola, e quelle di prima si tolgono", () => {
    const s = script(null);
    expect(s).not.toContain("NOPASSWD");
    expect(s).not.toContain("visudo");
    expect(s).not.toMatch(/cat > \/etc\/sudoers/);
    expect(s).toContain("rm -f /etc/sudoers.d/stubwise-read");
  });

  it("R-L8: in rigenerazione autorizza la vecchia E la nuova chiave", () => {
    const NEW = fakeSshPublicKey("SRV-1", 2, "2026-10-28T10:00:00Z");
    const s = installScript({
      serverCode: "SRV-1",
      key: NEW,
      previous: KEY,
      instanceAddress: "203.0.113.7",
    });
    const block = s
      .split("cat > /home/stubwise-read/.ssh/authorized_keys <<'KEY'\n")[1]!
      .split("\nKEY")[0]!;
    expect(block.split("\n")).toEqual([
      authorizedKeysLine(KEY, "203.0.113.7"),
      authorizedKeysLine(NEW, "203.0.113.7"),
    ]);
  });

  it("`from=` c'è solo quando l'indirizzo dell'istanza è noto", () => {
    expect(script(null)).not.toContain("from=");
    expect(authorizedKeysLine(KEY, "203.0.113.7")).toBe(
      `restrict,from="203.0.113.7" ${KEY.publicKey}`,
    );
  });

  it("stubwise-read non entra nel gruppo docker né in sudo", () => {
    for (const s of [script(null), script("203.0.113.7")]) {
      expect(s).not.toMatch(/usermod[^\n]*docker/);
      expect(s).not.toMatch(/usermod[^\n]*sudo/);
      expect(s).not.toMatch(/gpasswd[^\n]*-a/);
      expect(s).not.toMatch(/adduser[^\n]*docker/);
      expect(s).not.toMatch(/useradd[^\n]*-G/);
      expect(s).not.toMatch(/\bdocker (ps|logs|stats|inspect)\b/);
    }
  });

  it("R-L5: i gruppi di stubwise-read sono RIMPIAZZATI dal solo systemd-journal (F4b-3)", () => {
    expect(READ_GROUP).toBe("systemd-journal");
    const s = script(null);
    // `-G` senza `-a`: un utente che esisteva già perde i gruppi di prima (docker e sudo compresi).
    expect(s).toContain('usermod -g stubwise-read -G "systemd-journal" stubwise-read');
    expect(s).not.toMatch(/usermod[^\n]*-a/);
  });

  it("anche il gruppo PRIMARIO è normalizzato: un utente vecchio creato con -g docker lo perde", () => {
    const s = script(null);
    const ensure = s.indexOf("getent group stubwise-read >/dev/null || groupadd stubwise-read");
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(s.indexOf("usermod -g stubwise-read"));
  });

  it("non scarica né esegue niente da fuori e non contiene chiavi private", () => {
    const s = script("203.0.113.7");
    expect(s).not.toMatch(/\bcurl\b/);
    expect(s).not.toMatch(/\bwget\b/);
    expect(s).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(s).not.toContain("PRIVATE KEY");
  });
});

describe("la lingua dei commenti e degli echo", () => {
  const ITALIAN = /accesso|sola lettura|soltanto|pronto|rimoss|rimozione|gruppo|agente/;
  it("in inglese (default) nessun commento è in italiano; in italiano sì", () => {
    expect(script(null)).not.toMatch(ITALIAN);
    expect(removalScript("SRV-1")).not.toMatch(ITALIAN);
    const it_ = installScript({ serverCode: "SRV-1", key: KEY, instanceAddress: null, lang: "it" });
    expect(it_).toContain(
      "# Stubwise: accesso SSH di sola lettura per SRV-1 (solo la chiave pubblica).",
    );
    expect(removalScript("SRV-1", "it")).toContain('echo "Stubwise: accesso di SRV-1 rimosso."');
  });

  it("i comandi sono gli stessi nelle due lingue: cambiano solo commenti ed echo", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("#") && !l.startsWith("echo "))
        .join("\n");
    const en = installScript({ serverCode: "SRV-1", key: KEY, instanceAddress: null });
    const it_ = installScript({ serverCode: "SRV-1", key: KEY, instanceAddress: null, lang: "it" });
    expect(strip(en)).toBe(strip(it_));
    expect(strip(removalScript("SRV-1"))).toBe(strip(removalScript("SRV-1", "it")));
  });
});

describe("removalScript", () => {
  it("toglie il solo utente di lettura", () => {
    const s = removalScript("SRV-1");
    expect(s).toContain("userdel stubwise-read");
    expect(s).not.toContain("stubwise-fix");
    expect(s).toContain("rm -f /etc/sudoers.d/stubwise-read");
    expect(s).toContain("SRV-1");
    expect(s).not.toMatch(/\bcurl\b|\bwget\b/);
  });
});
