import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRenameProductPage } from "../../data/queries";
import type { ProductPageView } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";

// Il titolo di una pagina per chi scrive (shape product-editor.md §3.1,
// [PE 2]): l'h1 di 28 px resta l'unico h1 della pagina ed è lui il campo,
// nella stessa tipografia: nessun bordo a riposo, al passaggio la tinta ink
// 6 %, al fuoco l'anello. Invio porta al primo blocco; uscire salva
// (`renameProductPage`); vuoto torna al titolo di prima con la frase «A page
// needs a title». Il testo si scrive come testo semplice; il DOM lo scrive
// questo componente, mai React (il browser lo modifica mentre si scrive).

export const TitleField = forwardRef<
  HTMLHeadingElement,
  { page: ProductPageView; onEnter: () => void }
>(function TitleField({ page, onEnter }, ref) {
  const { t } = useTranslation();
  const toast = useToast();
  const rename = useRenameProductPage();
  const el = useRef<HTMLHeadingElement>(null);
  useImperativeHandle(ref, () => el.current!, []);
  // Il titolo mostrato: quello nuovo appena scritto, finché la lettura non lo porta.
  const [shown, setShown] = useState(page.title);
  const [seen, setSeen] = useState(page.title);
  if (seen !== page.title) {
    setSeen(page.title);
    setShown(page.title);
  }
  const [needsTitle, setNeedsTitle] = useState(false);

  useLayoutEffect(() => {
    const h = el.current;
    if (h && h.ownerDocument.activeElement !== h) h.textContent = shown;
  }, [shown]);

  const typed = () => (el.current?.textContent ?? "").replace(/\s+/g, " ").trim();

  const commit = () => {
    const h = el.current;
    if (!h) return;
    const value = typed();
    if (value === "") {
      h.textContent = shown;
      setNeedsTitle(true);
      return;
    }
    h.textContent = value;
    // Lo stesso titolo (anche uno già in volo) non scrive di nuovo.
    if (value === shown) return;
    const before = shown;
    setShown(value);
    rename.mutate(
      { pageId: page.id, title: value },
      {
        onError: () => {
          setShown(before);
          if (el.current) el.current.textContent = before;
          toast.error(t("productDocs.editor.title.renameFailed"));
        },
      },
    );
  };

  return (
    <h1
      ref={el}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      tabIndex={-1}
      title={needsTitle ? t("productDocs.editor.title.needsTitle") : undefined}
      onInput={() => setNeedsTitle(typed() === "")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          onEnter();
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (el.current) el.current.textContent = shown;
          setNeedsTitle(false);
        }
      }}
      onPaste={(e) => {
        // Solo testo, su una riga.
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s+/g, " ");
        if (typeof document.execCommand === "function") document.execCommand("insertText", false, text);
      }}
      onBlur={commit}
      className="-mx-1.5 rounded-md px-1.5 text-[28px] leading-9 font-semibold text-balance text-ink transition-colors duration-[var(--duration-fast)] ease-out [overflow-wrap:anywhere] outline-none hover:bg-ink/6 focus:bg-transparent focus-visible:outline-2 focus-visible:outline-focus"
    />
  );
});
