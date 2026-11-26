import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, releases, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

// Area 8, F4b (R0-D, R7): i container di un ambiente su un suo server, nella
// parte «Environments» dei rilasci. Si leggono nella riga; con
// `environments.manage` si scelgono fra quelli che l'agente riporta per quel
// server. Un container di un altro progetto lo rifiuta il livello dati.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

async function openAcq(person = "p-roberta") {
  renderRoute("/p/ACQ/releases", person);
  await screen.findByRole("heading", { level: 1, name: "Releases" });
  return screen.findByRole("region", { name: /^Environments/ });
}

const acqProd = () => state.environments.find((e) => e.id === "env-acq-prod")!;

describe("i container di un ambiente (R0-D)", () => {
  it("la riga li dice; dal menu si cambiano fra quelli che l'agente riporta", async () => {
    const part = await openAcq();
    expect(
      within(part).getByText(
        "Containers on SRV-1: portale-web, portale-api, portale-import, postgres",
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(part).getByRole("button", { name: "More for Production" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Containers on SRV-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Containers of Production on SRV-1" });
    // Il catalogo: i container docker che l'agente riporta su SRV-1.
    const boxes = await within(dialog).findAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("name"))).toEqual([
      "caddy",
      "portale-web",
      "portale-api",
      "portale-import",
      "postgres",
    ]);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "portale-import" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(acqProd().servers[0]!.containers).toEqual(["portale-web", "portale-api", "postgres"]);
  });

  it("un container già di un altro progetto: il dialogo lo dice e resta aperto", async () => {
    setSessionPersonId("p-roberta");
    const other = await createProject({ code: "SRVX", name: "Second", template: "software" });
    const env = await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    await releases.setEnvironmentContainers(env.id, { serverCode: "SRV-1", containers: ["caddy"] });
    const part = await openAcq();
    await userEvent.click(within(part).getByRole("button", { name: "More for Production" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Containers on SRV-1" }));
    const dialog = await screen.findByRole("dialog", { name: "Containers of Production on SRV-1" });
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "caddy" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A container you picked belongs to another project on this server.",
    );
    expect(acqProd().servers[0]!.containers).toHaveLength(4);
  });
});
