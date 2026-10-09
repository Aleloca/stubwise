import { inlineCodeSize, questionInlineCodeStyle, QUESTION_TEXT_STYLE } from "./markdown";

describe("codice inline nelle domande", () => {
  test("~90% della taglia del testo, arrotondato in su al mezzo punto, mai più grande", () => {
    expect(inlineCodeSize(16)).toBe(14.5);
    expect(inlineCodeSize(15)).toBe(13.5);
    expect(inlineCodeSize(13)).toBe(12);
    expect(inlineCodeSize(11)).toBe(10);
    for (let size = 8; size <= 30; size += 0.5) {
      expect(inlineCodeSize(size)).toBeLessThan(size);
      expect(inlineCodeSize(size)).toBeGreaterThanOrEqual(size * 0.9);
    }
  });

  test("la taglia si DERIVA dal testo che lo circonda, l'interlinea è la sua", () => {
    expect(questionInlineCodeStyle(QUESTION_TEXT_STYLE)).toMatchObject({ fontSize: 14.5, lineHeight: 22, fontWeight: "normal" });
    expect(questionInlineCodeStyle({ fontSize: 13, lineHeight: 18 })).toMatchObject({ fontSize: 12, lineHeight: 18 });
    expect(questionInlineCodeStyle({ fontSize: 16 })).not.toHaveProperty("lineHeight");
  });
});
