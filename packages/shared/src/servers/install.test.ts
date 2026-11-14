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
