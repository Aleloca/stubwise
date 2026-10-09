import { colors } from "./tokens";
import { fontFamily } from "./typography";
import {
  inlineCodeSize,
  QUESTION_OPTION_CONSEQUENCE_STYLE,
  QUESTION_OPTION_LABEL_STYLE,
  QUESTION_OPTION_PADDING,
  questionInlineCodeStyle,
  QUESTION_TEXT_STYLE,
} from "./markdown";

describe("taglie delle domande (un solo posto, 10 ott 2026)", () => {
  test("testo della domanda 15/21 SemiBold", () => {
    expect(QUESTION_TEXT_STYLE).toMatchObject({ fontFamily: fontFamily.sansSemiBold, fontSize: 15, lineHeight: 21, fontWeight: "600" });
  });

  test("etichetta di un'opzione 14/20 SemiBold", () => {
    expect(QUESTION_OPTION_LABEL_STYLE).toMatchObject({
      color: colors.fg,
      fontFamily: fontFamily.sansSemiBold,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "600",
    });
  });

  test("conseguenza 12.5/17 muted", () => {
    expect(QUESTION_OPTION_CONSEQUENCE_STYLE).toMatchObject({
      color: colors.muted,
      fontFamily: fontFamily.sans,
      fontSize: 12.5,
      lineHeight: 17,
    });
  });

  test("padding interno delle opzioni 12", () => {
    expect(QUESTION_OPTION_PADDING).toBe(12);
  });
});

describe("codice inline nelle domande", () => {
  test("~90% della taglia del testo, arrotondato in su al mezzo punto, mai più grande", () => {
    expect(inlineCodeSize(16)).toBe(14.5);
    expect(inlineCodeSize(15)).toBe(13.5);
    expect(inlineCodeSize(14)).toBe(13);
    expect(inlineCodeSize(13)).toBe(12);
    expect(inlineCodeSize(12.5)).toBe(11.5);
    expect(inlineCodeSize(11)).toBe(10);
    for (let size = 8; size <= 30; size += 0.5) {
      expect(inlineCodeSize(size)).toBeLessThan(size);
      expect(inlineCodeSize(size)).toBeGreaterThanOrEqual(size * 0.9);
    }
  });

  test("la taglia si DERIVA dal testo che lo circonda, l'interlinea è la sua", () => {
    expect(questionInlineCodeStyle(QUESTION_TEXT_STYLE)).toMatchObject({ fontSize: 13.5, lineHeight: 21, fontWeight: "normal" });
    expect(questionInlineCodeStyle(QUESTION_OPTION_LABEL_STYLE)).toMatchObject({ fontSize: 13, lineHeight: 20, fontWeight: "normal" });
    expect(questionInlineCodeStyle(QUESTION_OPTION_CONSEQUENCE_STYLE)).toMatchObject({ fontSize: 11.5, lineHeight: 17, fontWeight: "normal" });
    expect(questionInlineCodeStyle({ fontSize: 13, lineHeight: 18 })).toMatchObject({ fontSize: 12, lineHeight: 18 });
    expect(questionInlineCodeStyle({ fontSize: 16 })).not.toHaveProperty("lineHeight");
  });
});
