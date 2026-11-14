// Il comando d'installazione dell'agente di monitoraggio (area 8, F4a; era
// `dockerRunCommand` del web): web e app lo compongono uguale. La chiave si
// vede una volta sola (creazione e rigenerazione).

export const AGENT_IMAGE = "alelocadev/stubwise-agent";

export function agentInstallCommand(input: { instanceUrl: string; key: string }): string {
  const url = input.instanceUrl.replace(/\/+$/, "");
  return [
    "docker run -d --name stubwise-agent --restart unless-stopped --user 0 \\",
    '  --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    "  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
    `  -e STUBWISE_URL=${url} -e STUBWISE_SERVER_KEY=${input.key} \\`,
    `  ${AGENT_IMAGE}`,
  ].join("\n");
}
