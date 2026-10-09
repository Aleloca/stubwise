/**
 * Il pacchetto non pubblica tipi propri (nessun `.d.ts`, nessuna voce
 * `types`/`typings` in `package.json`, verificato scompattando il tarball) e
 * DefinitelyTyped non ha un `@types/react-native-markdown-display` (verificato
 * su npm). Dichiarazione MINIMA — solo la superficie che l'app usa davvero —
 * stesso principio di `globals.d.ts` in questa cartella.
 */
declare module "react-native-markdown-display" {
  import type { ComponentType, ReactNode } from "react";
  import type { StyleProp, TextStyle, ViewStyle } from "react-native";

  export interface MarkdownProps {
    children: ReactNode;
    style?: Record<string, StyleProp<ViewStyle | TextStyle>>;
    /**
     * Chiamata quando si tocca un link. Tornando `false` la libreria NON apre
     * niente da sé: l'apertura resta una decisione del chiamante, che così
     * può far passare l'URL dall'allowlist degli schemi
     * (`isSafeWebUrl`, `@stubwise/shared`). Senza questa prop il renderer
     * aprirebbe qualunque href, e un documento può contenere testo che non
     * abbiamo scritto noi.
     */
    onLinkPress?: (url: string) => boolean;
    /** Parser markdown-it da usare al posto del default (`typographer: true`). */
    markdownit?: MarkdownItInstance;
    /** Sostituisce il rendering di singoli nodi (solo la firma che usiamo). */
    rules?: Record<
      string,
      (
        node: { key: string; content?: string; attributes?: Record<string, string> },
        children: ReactNode,
      ) => ReactNode
    >;
  }

  /** Istanza opaca di markdown-it: l'app la crea e la passa, non la legge. */
  export interface MarkdownItInstance {
    readonly __markdownIt: unique symbol;
  }
  /** Il costruttore di markdown-it che la libreria ri-esporta. */
  export function MarkdownIt(options?: { typographer?: boolean }): MarkdownItInstance;

  /** Gli stili di default della libreria (li legge `theme/markdown.test.ts`). */
  export const styles: Record<string, Record<string, unknown>>;

  const Markdown: ComponentType<MarkdownProps>;
  export default Markdown;
}
