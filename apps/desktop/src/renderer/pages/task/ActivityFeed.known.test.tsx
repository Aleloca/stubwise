import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { PEOPLE } from "../../data/seed/people";
import { state, visibleProjectIds } from "../../data/store";
import { renderWithData } from "../../test/renderWithData";
import { strangersTo } from "../../test/strangers";
import { ActivityFeed } from "./ActivityFeed";

// Registro, A11 r.1414, revisione del lotto 2-3 (46): nella cronologia della
// task un cambio d'assegnatario verso uno sconosciuto a chi guarda arriva
// col segnaposto, e la riga scrive «someone», mai l'id né il nome.

const LAURA = "p-laura";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

describe("la cronologia della task senza chi non si conosce (r.1414)", () => {
  it("assegnatario cambiato verso uno sconosciuto: «someone»", async () => {
    const task = state.tasks.find((t) => visibleProjectIds(LAURA).has(t.projectId))!;
    const [who] = strangersTo(LAURA);
    const name = PEOPLE.find((p) => p.id === who)!.name;
    state.activity.push({
      id: "act-known-ui",
      taskId: task.id,
      kind: "field_change",
      authorId: "p-giulia",
      at: "2026-11-20T10:00:00Z",
      field: "assignee",
      from: "Giulia Ferri",
      to: name,
    });
    const { container } = renderWithData(<ActivityFeed task={task} canComment />, {
      personId: LAURA,
    });
    await waitFor(() => expect(container).toHaveTextContent("assignee: Giulia Ferri → someone"));
    expect(container).not.toHaveTextContent("hidden-");
    expect(container).not.toHaveTextContent(name);
  });
});
