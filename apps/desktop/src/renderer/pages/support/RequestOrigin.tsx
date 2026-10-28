import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSupportConversations } from "../../data/queries";
import type { ProjectRequest } from "../../data/types";
import { Section } from "../task/parts";
import { customerName } from "./format";
import { Messages } from "./Messages";

// «Da dove nasce» nel pannello della richiesta (shape support.md §5, [A 15]):
// una richiesta nata da una conversazione di Support dice da quale canale e
// da chi, col link alla conversazione, e la apre sul posto in sola lettura
// (chiusa di default). La conversazione si cerca fra quelle che chi guarda
// vede (R-G5): se non c'è, la sezione non c'è.

export function RequestOrigin({ request }: { request: ProjectRequest }) {
  const { t } = useTranslation();
  const origin = request.origin;
  const list = useSupportConversations(origin ? request.projectId : undefined);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const lastRef = useRef<HTMLLIElement>(null);
  const conv = origin ? list.data?.find((c) => c.id === origin.conversationId) : undefined;
  if (!conv) return null;
  return (
    <Section title={t("support.origin.title")}>
      <p data-request-origin className="text-sm text-ink-muted">
        {conv.channel === "widget" ? t("support.origin.widget") : t("support.origin.mcp")} ·{" "}
        {customerName(conv, t)}
        {conv.channel === "widget" && (
          <>
            {" · "}
            <Link
              to="/p/$code/support/$conversation"
              params={{ code: conv.projectCode, conversation: conv.code }}
              className="num rounded-sm font-semibold text-ink underline-offset-4 hover:underline"
            >
              {conv.code}
            </Link>
          </>
        )}
      </p>
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {open
            ? t("support.origin.hide")
            : t("support.origin.show", { count: conv.messages.length })}
        </button>
      </div>
      {open && (
        <div id={bodyId} className="pt-2">
          <Messages conv={conv} pending={null} lastSentRef={lastRef} />
        </div>
      )}
    </Section>
  );
}
