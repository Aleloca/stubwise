import { render, screen } from "@testing-library/react-native";
import { SearchSnippet } from "./SearchSnippet";

/**
 * L'estratto di un risultato di ricerca, uguale in ogni punto dell'app (26 set
 * 2026): senza il markdown del corpo e senza i marcatori `<b>` di
 * `ts_headline`, col pezzo marcato in grassetto.
 */
const RAW = "## Autenticazione\n\nIl **token** si rinnova col <b>refresh</b> ogni ora.";

function renderedText(): string {
  const root = screen.getByTestId("snippet");
  const flat = (children: unknown): string =>
    Array.isArray(children) ? children.map(flat).join("") : typeof children === "string" ? children : "";
  return flat(root.props.children.map((child: { props: { children: unknown } }) => child.props.children));
}

describe("SearchSnippet", () => {
  test("toglie titoli, grassetti markdown e <b>: resta il testo", async () => {
    await render(<SearchSnippet snippet={RAW} testID="snippet" />);
    const text = renderedText();
    expect(text).not.toMatch(/##|\*\*|<b>|<\/b>/);
    expect(text).toContain("Autenticazione");
    expect(text).toContain("token");
    expect(text).toContain("refresh");
  });

  test("il pezzo marcato da <b> è in evidenza, il resto no", async () => {
    await render(<SearchSnippet snippet={RAW} testID="snippet" />);
    const highlighted = screen.getByTestId("snippet-match-0");
    expect(highlighted.props.children).toBe("refresh");
  });

  test("uno snippet vuoto o assente non rende niente", async () => {
    await render(<SearchSnippet snippet={null} testID="snippet" />);
    expect(screen.queryByTestId("snippet")).toBeNull();
    await render(<SearchSnippet snippet="" testID="snippet" />);
    expect(screen.queryByTestId("snippet")).toBeNull();
  });
});
