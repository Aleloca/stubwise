import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithData } from "../../test/renderWithData";
import { FieldRows } from "./SourcePanel";

// I dati di una sorgente si leggono con le stesse etichette del costruttore:
// dove c'è una traduzione, nella lingua di chi guarda (review finale 10b, 4).

describe("FieldRows", () => {
  it("in inglese: «Urgency» e «Request title», non le etichette italiane del dato", () => {
    renderWithData(
      <ul>
        <FieldRows
          fields={[
            { key: "richiesta.urgenza", label: "Urgenza", type: "text" },
            { key: "richiesta.titolo", label: "Titolo della richiesta", type: "text" },
          ]}
        />
      </ul>,
    );
    expect(screen.getByText("Urgency")).toBeInTheDocument();
    expect(screen.getByText("Request title")).toBeInTheDocument();
    expect(screen.queryByText("Urgenza")).toBeNull();
  });
});
