import { useTranslation } from "react-i18next";
import { primaryButton, quietButton, secondaryButton } from "../claude/conversation/parts";

// L'incaricato fuori dal progetto, alla conferma (shape mail.md §4, A15): un
// passo in linea in fondo alla scheda, sopra i bottoni — non un dialogo.
// Chi può aggiungere persone al progetto (`project.members.manage`) le
// aggiunge come Contributor e conferma, tutto o niente; chi non può sceglie
// un'altra persona o conferma senza incaricato. Chiede a chi guarda: si
// annuncia `assertive`.

/** «Chiara Lombardi», «Chiara Lombardi e Tommaso Riva», «A, B e C». */
function namesList(names: readonly string[], and: string): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;
}

export function OutsiderPrompt({
  outsiders,
  code,
  canAdd,
  busy,
  onAdd,
  onChoose,
  onLeave,
}: {
  outsiders: readonly { personId: string; name: string }[];
  /** Il codice del progetto. */
  code: string;
  canAdd: boolean;
  busy: boolean;
  onAdd: () => void;
  onChoose: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const names = namesList(
    outsiders.map((o) => o.name),
    t("mail.outsider.and"),
  );
  const many = outsiders.length > 1;
  const text = canAdd
    ? t(many ? "mail.outsider.askMany" : "mail.outsider.ask", { name: names, names, code })
    : t(many ? "mail.outsider.cantMany" : "mail.outsider.cant", { name: names, names, code });
  return (
    <div data-outsider-prompt className="flex flex-col gap-3 border-l border-rule-strong pl-3">
      <div role="alert" aria-live="assertive" className="flex flex-col gap-1.5 text-sm text-ink">
        {many && (
          <ul className="flex flex-col">
            {outsiders.map((o) => (
              <li key={o.personId} className="font-medium">
                {o.name}
              </li>
            ))}
          </ul>
        )}
        <p className="max-w-[68ch]">{text}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={quietButton} disabled={busy} onClick={onChoose}>
          {t("mail.outsider.choose")}
        </button>
        {canAdd ? (
          <>
            <button type="button" className={secondaryButton} disabled={busy} onClick={onLeave}>
              {t("mail.outsider.leave")}
            </button>
            <button type="button" className={primaryButton} disabled={busy} onClick={onAdd}>
              {t("mail.outsider.addConfirm")}
            </button>
          </>
        ) : (
          <button type="button" className={primaryButton} disabled={busy} onClick={onLeave}>
            {t("mail.outsider.confirmUnassigned")}
          </button>
        )}
      </div>
    </div>
  );
}
