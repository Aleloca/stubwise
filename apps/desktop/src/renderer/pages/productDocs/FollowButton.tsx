import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFollowProductPage, useUnfollowProductPage } from "../../data/queries";
import type { ProductPageView } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";

// «Follow» / «Following» nella barra della pagina (shape
// product-comments-history.md §3.8, [PC 11]): la stessa forma del
// «Following» del pannello della task — l'occhio pieno, `aria-pressed`, la
// tinta ink 10%. Per chiunque legga la pagina, anche senza `docs.edit`.
// Ottimistico: lo stato cambia subito, un errore lo rimette e lo dice con
// «Retry». Nel `title` e nel nome accessibile chi segue (P33), solo le
// persone che chi guarda vede (il livello dati le filtra, R-G5).

export const pageBarButton =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-pressed:bg-ink/10 aria-pressed:text-ink";

export function FollowButton({ page }: { page: ProductPageView }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const follow = useFollowProductPage();
  const unfollow = useUnfollowProductPage();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [announce, setAnnounce] = useState("");
  const on = optimistic ?? page.following;

  // La lettura ha raggiunto lo stato scelto: l'ottimistico non serve più.
  useEffect(() => {
    if (optimistic !== null && page.following === optimistic) setOptimistic(null);
  }, [optimistic, page.following]);

  const run = (next: boolean) => {
    setOptimistic(next);
    setAnnounce(t(next ? "productDocs.follow.announceOn" : "productDocs.follow.announceOff"));
    (next ? follow : unfollow).mutate(page.id, {
      onError: () => {
        setOptimistic(null);
        setAnnounce("");
        toast.error(t("productDocs.follow.failed"), {
          action: { label: t("productDocs.follow.retry"), run: () => run(next) },
        });
      },
    });
  };

  const followers = page.followers ?? [];
  const names = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(followers.map((f) => f.name));
  const who =
    followers.length === 0
      ? t("productDocs.follow.followedByNone")
      : t("productDocs.follow.followedBy", { count: followers.length, names });
  const label = t(on ? "productDocs.follow.following" : "productDocs.follow.follow");
  const hint = t(on ? "productDocs.follow.hintOn" : "productDocs.follow.hint");

  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-label={`${label} · ${who}`}
        title={`${hint}\n${who}`}
        onClick={() => run(!on)}
        className={pageBarButton}
      >
        <EyeIcon filled={on} />
        {label}
      </button>
      {/* Un annuncio senza `role`: lo stato della barra ha già il suo `status` (il salvataggio). */}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </>
  );
}

/** L'occhio del «Follow» (lo stesso disegno del pannello della task). */
function EyeIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="2" fill={filled ? "currentColor" : "none"} />
    </svg>
  );
}
