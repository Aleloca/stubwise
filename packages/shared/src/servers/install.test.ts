import { describe, expect, it } from "vitest";
import { agentInstallCommand } from "./install.js";

// Area 8, F4a: il comando d'installazione dell'agente in UN posto (era
// `dockerRunCommand` del web): web e app lo compongono uguale.

describe("agentInstallCommand", () => {
  it("lo stesso testo del web, con l'istanza e la chiave", () => {
    expect(agentInstallCommand({ instanceUrl: "https://s.example/", key: "sk_abc" })).toBe(
      [
        "docker run -d --name stubwise-agent --restart unless-stopped --user 0 \\",
        '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
        "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
        "  -e STUBWISE_URL=https://s.example -e STUBWISE_SERVER_KEY=sk_abc \\",
        "  alelocadev/stubwise-agent",
      ].join("\n"),
    );
  });
});

describe("agentInstallCommand con le operazioni (area 8, F4b)", () => {
  it("accende l'opzione e fissa la chiave pubblica; senza, il comando di prima", () => {
    const withOps = agentInstallCommand({ instanceUrl: "https://s.example", key: "sk_abc", operations: { publicKey: "PUBKEY" } });
    expect(withOps).toContain("-e STUBWISE_OPERATIONS=1 -e STUBWISE_COMMAND_PUBLIC_KEY=PUBKEY");
    // I nonce su un volume: un container ricreato non riaccetta un comando già visto.
    expect(withOps).toContain("-v stubwise-agent-state:/var/lib/stubwise-agent");
    expect(agentInstallCommand({ instanceUrl: "https://s.example", key: "sk_abc" })).not.toContain("STUBWISE_OPERATIONS");
  });
});
