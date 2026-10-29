import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../data/model";
import { SERVER_CONVERSATIONS } from "../../data/seed/servers/analysis";
import { isReadCommand, READ_COMMANDS, truncateOutput } from "./commands";
import { COMMAND_OUTPUT_MAX_LINES } from "./limits";

const ok = (cmd: string) => expect(isReadCommand(cmd), cmd).toBe(true);
const no = (cmd: string) => expect(isReadCommand(cmd), cmd).toBe(false);

describe("isReadCommand", () => {
  it("vero per ogni READ_COMMANDS (con il container, dove serve)", () => {
    for (const cmd of READ_COMMANDS) ok(cmd === "sudo docker logs" ? `${cmd} api` : cmd);
  });

  it("accetta ogni comando della sessione d'analisi del seme", () => {
    const inputs = SERVER_CONVERSATIONS.flatMap((s) => s.events)
      .filter((e): e is Extract<ConversationEvent, { type: "action" }> => e.type === "action")
      .map((e) => e.input ?? "");
    expect(inputs.length).toBeGreaterThanOrEqual(6);
    for (const input of inputs) ok(input);
  });

  it("falso per ciò che non è un comando di lettura", () => {
    for (const cmd of [
      "docker inspect x",
      "sudo docker inspect x",
      "docker restart x",
      "sudo docker restart x",
      "docker ps",
      "rm -rf /tmp/x",
      "sudo -n true",
      "sudo systemctl restart docker",
      "systemctl restart docker",
      "freeze",
      "psql",
      "",
    ]) {
      no(cmd);
    }
  });

  it("falso per ogni composizione con la shell e per le virgolette", () => {
    for (const cmd of [
      "uptime; rm -rf /",
      "ps aux | sh",
      "df -h && reboot",
      "free $(reboot)",
      "free `reboot`",
      "uptime > /tmp/x",
      "journalctl -u 'a b'",
      "journalctl -u ${X}",
    ]) {
      no(cmd);
    }
  });

  describe("journalctl (R-L5): senza sudo, solo opzioni dell'elenco", () => {
    it("le opzioni ammesse", () => {
      ok("journalctl -u docker --since -30min --no-pager");
      ok("journalctl --unit=nginx.service --until 2026-10-29 -n 200");
      ok("journalctl -p err -o short-iso --no-pager");
      ok("journalctl --priority=warning --output=json -b");
      ok("journalctl -k -r --lines=50");
    });

    it("con sudo non passa più", () => {
      no("sudo journalctl -u docker --no-pager");
    });

    it("le opzioni che scrivono, anche abbreviate (getopt_long)", () => {
      for (const cmd of [
        "journalctl --vacuum-size=1M",
        "journalctl --vacuum-s=1M",
        "journalctl --vacuum-t=1s",
        "journalctl --rotate",
        "journalctl --rot",
        "journalctl --flush",
        "journalctl --flu",
        "journalctl --sync",
        "journalctl --setup-keys",
        "journalctl --relinquish-var",
        "journalctl -n1 --cursor-file=/etc/sudoers.d/x",
        "journalctl -n1 --cursor-file /etc/shadow",
        "journalctl --unt=x",
        "journalctl --update-catalog",
      ]) {
        no(cmd);
      }
    });

    it("valori fuori elenco o mancanti", () => {
      no("journalctl -o export");
      no("journalctl --output=export");
      no("journalctl -n");
      no("journalctl -n abc");
      no("journalctl -u");
      no("journalctl /var/log/x");
      no("journalctl -D /tmp/x");
      no("journalctl --directory=/tmp/x");
    });
  });

  it("ss: solo -tlnp, niente -K né -D", () => {
    ok("ss -tlnp");
    no("ss -tlnp -K dst 1.2.3.4");
    no("ss -tlnp -D /tmp/x");
    no("ss -a");
  });

  it("systemctl status: unità e opzioni di lettura, niente -H/-M", () => {
    ok("systemctl status nginx docker.service --no-pager -n 50");
    ok("systemctl status -l --lines=20");
    no("systemctl status -H root@other nginx");
    no("systemctl status --host=other nginx");
    no("systemctl status -M box nginx");
    no("sudo systemctl status nginx");
  });

  it("docker con sudo: solo le opzioni di lettura", () => {
    ok("sudo docker ps -a --no-trunc");
    ok("sudo docker ps --format {{.Names}}");
    ok("sudo docker ps -f status=running");
    ok("sudo docker logs --tail 200 portale-import");
    ok("sudo docker logs -t --since 30m api");
    ok("sudo docker stats --no-stream");
    ok("sudo docker stats --no-stream api db");
    no("sudo docker logs -f api");
    no("sudo docker logs --follow api");
    no("sudo docker logs api db");
    no("sudo docker logs");
    no("sudo docker ps --rm");
    no("sudo docker stats");
  });

  it("df, free, ps, uptime: solo le opzioni dell'elenco", () => {
    ok("df -h");
    ok("df -hT /var");
    ok("free -m");
    ok("free -h --wide");
    ok("ps aux --sort=-%mem");
    ok("ps -ef");
    ok("ps -e -o pid,comm,%mem --sort=-%mem");
    ok("uptime -p");
    no("df --output=/tmp/x");
    no("df relative/path");
    no("free -s 1");
    no("ps aux extra");
    no("uptime --bogus");
  });
});

describe("truncateOutput", () => {
  it("5000 righe → le ultime 40, troncato", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = truncateOutput(text);
    expect(out.truncated).toBe(true);
    const lines = out.text.split("\n");
    expect(lines).toHaveLength(COMMAND_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("line 4961");
    expect(lines.at(-1)).toBe("line 5000");
  });

  it("un'uscita corta resta intera", () => {
    expect(truncateOutput("a\nb\n")).toEqual({ text: "a\nb\n", truncated: false });
    const forty = Array.from({ length: 40 }, () => "x").join("\n");
    expect(truncateOutput(forty)).toEqual({ text: forty, truncated: false });
  });
});
