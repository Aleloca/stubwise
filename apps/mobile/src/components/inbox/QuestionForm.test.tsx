import type { InboxQuestion, Reader } from "@stubwise/shared";
import { Linking, StyleSheet } from "react-native";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
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
  test("di default (inbox, ticket, chat del backlog, sessione) testo, etichetta e conseguenza sono markdown", async () => {
    const q = { ...question, question: "Tengo `parse()` o **lo tolgo**?" } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    // Il testo: lo stesso renderer a blocchi della sessione (SafeMarkdown).
    expect(JSON.stringify(screen.getByText("parse()").props.style)).toContain(fontFamily.mono);
    expect(JSON.stringify(screen.getByText("lo tolgo").props.style)).toContain(fontFamily.sansBold);
    // Etichetta e conseguenza: inline, nella stessa opzione premibile.
    expect(JSON.stringify(screen.getByText("format(3.14)").props.style)).toContain(fontFamily.mono);
    expect(JSON.stringify(screen.getByText("Number()").props.style)).toContain(fontFamily.mono);
    expect(screen.queryByText(/`/)).toBeNull();
    expect(screen.getByRole("radio", { name: /Italiano: format\(3\.14\)/ })).toBeTruthy();
  });

  test("il testo della domanda è 15/21 SemiBold (non più un titolo 20/26), col codice in mono", async () => {
    const q = { ...question, question: "Tengo `parse()`?" } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    const leaf = StyleSheet.flatten(screen.getByText("Tengo").props.style);
    expect(leaf).toMatchObject({ fontFamily: fontFamily.sansSemiBold, fontSize: 15, lineHeight: 21 });
    expect(JSON.stringify(screen.getByText("parse()").props.style)).toContain(fontFamily.mono);
  });

  test("il codice inline è ~90% del testo che lo circonda, mai più grande, con la stessa interlinea (testo, etichetta, conseguenza)", async () => {
    const q = { ...question, question: "Tengo `parse()`?" } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    const pairs: [string, string][] = [
      ["Tengo", "parse()"],
      ["Italiano:", "format(3.14)"],
      ["Chi legge con", "Number()"],
    ];
    for (const [text, code] of pairs) {
      const around = StyleSheet.flatten(screen.getByText(text).props.style);
      const inline = StyleSheet.flatten(screen.getByText(code).props.style);
      expect(inline.fontSize).toBeLessThan(around.fontSize as number);
      expect(inline.fontSize).toBeGreaterThanOrEqual((around.fontSize as number) * 0.85);
      expect(inline.lineHeight).toBe(around.lineHeight);
      // Il mono è Regular: un "600" ereditato dal testo farebbe un falso grassetto.
      expect(inline.fontWeight).toBe("normal");
    }
    expect(StyleSheet.flatten(screen.getByText("parse()").props.style)).toMatchObject({ fontSize: 13.5, lineHeight: 21 });
    expect(StyleSheet.flatten(screen.getByText("Number()").props.style)).toMatchObject({ fontSize: 11.5, lineHeight: 17 });
  });

  test("il testo della domanda non passa dalla tipografia: `--flag` e l'apostrofo restano come scritti", async () => {
    const q = { ...question, question: "Uso --force sull'importo?" } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(screen.getByText("Uso --force sull'importo?")).toBeTruthy();
  });

  test("etichette e conseguenze non passano dalla tipografia: `--force`, l'apostrofo e le virgolette restano come scritti", async () => {
    const q = {
      ...question,
      options: [{ label: "Usa --force sull'importo", consequence: "Scrive \"3,14\" -- senza conferma" }, { label: "No" }],
    } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(screen.getByText("Usa --force sull'importo")).toBeTruthy();
    expect(screen.getByText('Scrive "3,14" -- senza conferma')).toBeTruthy();
  });

  test("le immagini nel testo, nelle etichette e nelle conseguenze non si caricano: resta l'alt", async () => {
    const q = {
      ...question,
      question: "Is ![the chart](https://x.test/q.png) right?",
      options: [{ label: "Vedi ![pixel](https://x.test/l.png)", consequence: "Tiene ![c](https://x.test/c.png)" }, { label: "No" }],
    } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(JSON.stringify(screen.toJSON())).not.toContain("x.test");
    expect(screen.getByText("the chart")).toBeTruthy();
    expect(screen.getByText("pixel")).toBeTruthy();
  });

  test("il codice inline è in stile codice, senza backtick, nella STESSA opzione premibile", async () => {
    await render(<QuestionForm question={question} {...props} />);
    const code = screen.getByText("format(3.14)");
    expect(JSON.stringify(code.props.style)).toContain(fontFamily.mono);
    expect(screen.getByText("Number()")).toBeTruthy();
    expect(screen.queryByText(/`/)).toBeNull();
    expect(screen.getByRole("radio", { name: /Italiano: format\(3\.14\)/ })).toBeTruthy();
  });

  test("il testo mantiene lo stile dell'opzione (etichetta 14/20 SemiBold, conseguenza 12.5/17 muted), con e senza markdown", async () => {
    await render(<QuestionForm question={question} {...props} />);
    expect(StyleSheet.flatten(screen.getByText("Italiano:").props.style)).toMatchObject({
      fontFamily: fontFamily.sansSemiBold,
      fontSize: 14,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByText("Chi legge con").props.style)).toMatchObject({
      color: colors.muted,
      fontFamily: fontFamily.sans,
      fontSize: 12.5,
      lineHeight: 17,
    });
    // Il codice inline scende da solo con la regola del 90% (14 → 13, 12.5 → 11.5).
    expect(StyleSheet.flatten(screen.getByText("format(3.14)").props.style)).toMatchObject({ fontSize: 13, lineHeight: 20 });
    expect(StyleSheet.flatten(screen.getByText("Number()").props.style)).toMatchObject({ fontSize: 11.5, lineHeight: 17 });
    const label = JSON.stringify(screen.getByTestId("question-form-option-0").children);
    // Le vecchie taglie (16 etichetta, 18 interlinea della conseguenza) non restano da nessuna parte.
    expect(label).not.toMatch(/"fontSize":16[,}]/);
    expect(label).not.toMatch(/"lineHeight":18[,}]/);
    expect(StyleSheet.flatten(screen.getByText("Semplice").props.style)).toMatchObject({
      fontFamily: fontFamily.sansSemiBold,
      fontSize: 14,
      lineHeight: 20,
    });
  });

  test("«Other (free text)» ha la taglia delle etichette (14/20 SemiBold)", async () => {
    const q = { ...question, allowFreeText: true } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    const other = within(screen.getByTestId("question-form-other"));
    const leaf = StyleSheet.flatten(other.getByText(/./).props.style);
    expect(leaf).toMatchObject({ fontFamily: fontFamily.sansSemiBold, fontSize: 14, lineHeight: 20 });
  });

  test("il padding interno delle opzioni è 12", async () => {
    const q = { ...question, allowFreeText: true } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    for (const id of ["question-form-option-0", "question-form-option-1", "question-form-other"]) {
      expect(StyleSheet.flatten(screen.getByTestId(id).props.style).padding).toBe(12);
    }
  });

  test("i blocchi (titolo, elenco, immagine) restano testo semplice, senza View né immagini", async () => {
    const q = {
      ...question,
      options: [{ label: "# Titolo" }, { label: "- voce" }, { label: "![alt qui](https://x.test/a.png)" }],
    } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(screen.getByText("# Titolo")).toBeTruthy();
    expect(screen.getByText("- voce")).toBeTruthy();
    expect(screen.getByText("alt qui")).toBeTruthy();
    for (const i of [0, 1, 2]) {
      const json = JSON.stringify(screen.getByTestId(`question-form-option-${i}`).children);
      expect(json).not.toContain("FitImage");
      expect(json).not.toContain('"uri"');
    }
  });

  test("un link nell'etichetta resta testo: toccarlo non apre niente e non è sottolineato", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue();
    const q = { ...question, options: [{ label: "Vedi [doc](https://x.test)" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(screen.getByRole("radio", { name: /Vedi doc/ })).toBeTruthy();
    expect(JSON.stringify(screen.getByText("doc").props.style ?? null)).not.toContain("underline");
    await fireEvent.press(screen.getByText("doc"));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test("«1. first» e «2024) year» si leggono senza backslash", async () => {
    const q = { ...question, options: [{ label: "1. first" }, { label: "2024) year" }, { label: "1.5 stays" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} {...props} />);
    expect(screen.getByText("1. first")).toBeTruthy();
    expect(screen.getByText("2024) year")).toBeTruthy();
    expect(screen.getByText("1.5 stays")).toBeTruthy();
  });

  test("l'enfasi a inizio riga resta enfasi e i caratteri che non aprono un blocco restano intatti", async () => {
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
    await render(<QuestionForm question={q} {...props} />);
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

describe("QuestionForm — spaziatura", () => {
  test("il bottone di invio è staccato dall'ultima opzione più delle opzioni fra loro", async () => {
    // Visto sul telefono: «Invia la risposta» attaccato a «Other (free text)».
    await render(<QuestionForm question={question} {...props} />);
    const optionGap = StyleSheet.flatten(screen.getByTestId("question-form-option-0").props.style).marginTop as number;
    const row = screen.getByTestId("question-form-submit-row");
    expect(row).toBeTruthy();
    const rowGap = StyleSheet.flatten(row.props.style).marginTop as number;
    expect(rowGap).toBeGreaterThanOrEqual(16);
    expect(rowGap).toBeGreaterThan(optionGap);
  });
});
