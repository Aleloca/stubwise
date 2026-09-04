/**
 * Il pacchetto non pubblica tipi propri (nessun `.d.ts`, nessuna voce
 * `types`/`typings` in `package.json`, verificato scompattando il tarball) e
 * DefinitelyTyped non ha un `@types/react-native-markdown-display` (verificato
 * su npm). Dichiarazione MINIMA — solo la superficie che `PlanSection.tsx`
 * usa davvero — stesso principio di `globals.d.ts` in questa cartella.
 */
declare module "react-native-markdown-display" {
  import type { ComponentType, ReactNode } from "react";
  import type { StyleProp, TextStyle, ViewStyle } from "react-native";

  export interface MarkdownProps {
    children: ReactNode;
    style?: Record<string, StyleProp<ViewStyle | TextStyle>>;
  }

  const Markdown: ComponentType<MarkdownProps>;
  export default Markdown;
}
