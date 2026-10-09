import type { InboxQuestion, Reader } from "@stubwise/shared";
import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
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

  test("con markdownQuestion un link nell'etichetta resta testo: toccarlo non apre niente e non è sottolineato", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const q = { ...question, options: [{ label: "Vedi [doc](https://x.test)" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    expect(screen.getByRole("radio", { name: /Vedi doc/ })).toBeTruthy();
    expect(JSON.stringify(screen.getByText("doc").props.style ?? null)).not.toContain("underline");
    await fireEvent.press(screen.getByText("doc"));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("con markdownQuestion «1. first» e «2024) year» si leggono senza backslash", async () => {
    const q = { ...question, options: [{ label: "1. first" }, { label: "2024) year" }, { label: "1.5 stays" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    expect(screen.getByText("1. first")).toBeTruthy();
    expect(screen.getByText("2024) year")).toBeTruthy();
    expect(screen.getByText("1.5 stays")).toBeTruthy();
  });

  test("con markdownQuestion l'enfasi a inizio riga resta enfasi e i caratteri che non aprono un blocco restano intatti", async () => {
    const q = {
      ...question,
      options: [
        { label: "**bold** first" },
        { label: "*it* first" },
        { label: "-1 is fine" },
        { label: "#3 option" },
        { label: "+1 vote" },
        { label: "> quote" },
        { label: "a\n- b" },
        { label: "```js" },
      ],
    } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    const bold = JSON.stringify(screen.getByTestId("question-form-option-0").children);
    expect(bold).toContain("bold");
    expect(bold).not.toContain("*");
    expect(bold).toContain(fontFamily.sansBold);
    const it = JSON.stringify(screen.getByTestId("question-form-option-1").children);
    expect(it).not.toContain("*");
    expect(screen.getByText("-1 is fine")).toBeTruthy();
    expect(screen.getByText("#3 option")).toBeTruthy();
    expect(screen.getByText("+1 vote")).toBeTruthy();
    expect(screen.getByText("> quote")).toBeTruthy();
    expect(screen.getByText("- b")).toBeTruthy();
    expect(screen.getByText("```js")).toBeTruthy();
  });
});
