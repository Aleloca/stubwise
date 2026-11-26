// Il comando d'installazione dell'agente di monitoraggio (area 8, F4a; era
// `dockerRunCommand` del web): web e app lo compongono uguale. La chiave si
// vede una volta sola (creazione e rigenerazione).

export const AGENT_IMAGE = "alelocadev/stubwise-agent";

/**
 * Area 8, F4b: con `operations` il comando accende l'opzione
 * (`STUBWISE_OPERATIONS=1`) e FISSA la chiave pubblica che verifica i
 * comandi (`STUBWISE_COMMAND_PUBLIC_KEY`): l'agente non la scarica mai dal
 * server. Senza, il comando di prima.
 */
export function agentInstallCommand(input: { instanceUrl: string; key: string; operations?: { publicKey: string } }): string {
  const url = input.instanceUrl.replace(/\/+$/, "");
  return [
    "docker run -d --name stubwise-agent --restart unless-stopped --user 0 \\",
    '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
    `  -e STUBWISE_URL=${url} -e STUBWISE_SERVER_KEY=${input.key} \\`,
    ...(input.operations
      ? [
          `  -e STUBWISE_OPERATIONS=1 -e STUBWISE_COMMAND_PUBLIC_KEY=${input.operations.publicKey} \\`,
          // I nonce dei comandi visti sopravvivono a un container ricreato (review F4b).
          "  -v stubwise-agent-state:/var/lib/stubwise-agent \\",
        ]
      : []),
    `  ${AGENT_IMAGE}`,
  ].join("\n");
}
