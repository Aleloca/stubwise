import type { InboxQuestion, Reader } from "@stubwise/shared";
import { render, screen } from "@testing-library/react-native";
import "../../i18n";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { QuestionForm } from "./QuestionForm";

const question = {
  questionId: "q1",
  round: 1,
  question: "Quale?",
  options: [
    { label: "Italiano: `format(3.14)`", consequence: "Chi legge con `Number()` si rompe" },
    { label: "Semplice" },
  ],
  allowFreeText: false,
} as unknown as Reader<InboxQuestion>;

const props = { onSubmit: jest.fn(), pending: false, disabled: false, online: true, errorMessage: null };

describe("QuestionForm — opzioni", () => {
  test("senza markdownQuestion (inbox) etichetta e conseguenza restano testo semplice", async () => {
    await render(<QuestionForm question={question} {...props} />);
    expect(screen.getByText("Italiano: `format(3.14)`")).toBeTruthy();
    expect(screen.getByText("Chi legge con `Number()` si rompe")).toBeTruthy();
  });

  test("con markdownQuestion il codice inline è in stile codice, senza backtick, nella STESSA opzione premibile", async () => {
    await render(<QuestionForm question={question} markdownQuestion {...props} />);
    const code = screen.getByText("format(3.14)");
    expect(JSON.stringify(code.props.style)).toContain(fontFamily.mono);
    expect(screen.getByText("Number()")).toBeTruthy();
    expect(screen.queryByText(/`/)).toBeNull();
    expect(screen.getByRole("radio", { name: /Italiano: format\(3\.14\)/ })).toBeTruthy();
  });

  test("con markdownQuestion il testo mantiene lo stile dell'opzione (etichetta SemiBold 16, conseguenza muted 13), con e senza markdown", async () => {
    await render(<QuestionForm question={question} markdownQuestion {...props} />);
    const label = JSON.stringify(screen.getByTestId("question-form-option-0").children);
    expect(label).toContain(fontFamily.sansSemiBold);
    expect(label).toContain('"fontSize":16');
    expect(label).toContain('"fontSize":13');
    expect(label).toContain(colors.muted);
    expect(label).not.toContain('"fontSize":14');
    const plain = JSON.stringify(screen.getByTestId("question-form-option-1").children);
    expect(plain).toContain(fontFamily.sansSemiBold);
    expect(plain).toContain('"fontSize":16');
    expect(plain).not.toContain('"fontSize":14');
  });

  test("con markdownQuestion i blocchi (titolo, elenco, immagine) restano testo semplice, senza View né immagini", async () => {
    const q = {
      ...question,
      options: [{ label: "# Titolo" }, { label: "- voce" }, { label: "![alt qui](https://x.test/a.png)" }],
    } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    expect(screen.getByText("# Titolo")).toBeTruthy();
    expect(screen.getByText("- voce")).toBeTruthy();
    expect(screen.getByText("alt qui")).toBeTruthy();
    for (const i of [0, 1, 2]) {
      const json = JSON.stringify(screen.getByTestId(`question-form-option-${i}`).children);
      expect(json).not.toContain("FitImage");
      expect(json).not.toContain('"uri"');
    }
  });

  test("con markdownQuestion un link nell'etichetta resta testo: nessun nodo dell'opzione è premibile da sé", async () => {
    const q = { ...question, options: [{ label: "Vedi [doc](https://x.test)" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    expect(screen.getByRole("radio", { name: /Vedi doc/ })).toBeTruthy();
    const onPresses = screen
      .getAllByText(/Vedi|doc/)
      .filter((n) => typeof n.props.onPress === "function" || n.props.accessibilityRole === "link");
    expect(onPresses).toHaveLength(0);
  });
});
