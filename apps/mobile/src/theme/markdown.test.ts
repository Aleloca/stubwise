import { styles as libraryDefaults } from "react-native-markdown-display";
import { MARKDOWN_STYLE } from "./markdown";

const COLOR_KEYS = ["color", "backgroundColor", "borderColor"] as const;

/**
 * I default della libreria sono pensati per uno sfondo chiaro: un colore che
 * non sovrascriviamo finisce sul tema scuro così com'è (la citazione su
 * `#F5F5F5`, illeggibile, 5 ott 2026). Il test legge i default VERI, quindi
 * copre anche un elemento che la libreria colorasse in una versione futura.
 */
describe("MARKDOWN_STYLE", () => {
  it("sovrascrive ogni colore di default della libreria", () => {
    const missing: string[] = [];
    for (const [element, style] of Object.entries(libraryDefaults as Record<string, Record<string, unknown>>)) {
      const ours = (MARKDOWN_STYLE as Record<string, Record<string, unknown> | undefined>)[element] ?? {};
      for (const key of COLOR_KEYS) {
        if (key in style && !(key in ours)) missing.push(`${element}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
