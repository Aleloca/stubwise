import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ACTIONS,
  actionById,
  groupsFor,
  useWhatCan,
  useWhoCan,
  useWhoCanChoices,
  type WhatCanView,
  type WhoCanReason,
  type WhoCanView,
} from "../../data/queries";
import { INSTANCE_ONLY } from "../../data/routes";
import { Chevron } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { formatDate } from "../../notifications/time";
import { Switch } from "../preferences/SubscriptionRow";
import { AdminAvatar, capitalized, usePermissionHint, usePermissionWords } from "./parts";

// «Who can?» (shape admin-audit.md, `/admin/who-can`): due domande scritte
// come frasi, coi menu in linea [AU 1]. «Who can [approve a plan ▾] in
// [ACQ ▾]?» risponde con una riga per persona e il perché in prosa [AU 3],
// poi Claude a parte; «What can [Marco ▾] do in [ACQ ▾]?» con i permessi che
// ha, ognuno con la sua fonte. Le risposte sono `can()` (`api.access`), e i
// menu offrono solo progetti e persone che chi guarda vede (R-G5): un
// indirizzo con un progetto invisibile torna su «Choose a project».

const CLAUDE = "p-claude";

interface Search {
  view?: string;
  action?: string;
  person?: string;
  project?: string;
}

/** Il perché di una persona, in prosa breve: «Project Lead role», «given by Roberta on Oct 29». */
export function useReasonWords() {
  const { t, i18n } = useTranslation();
  return (r: WhoCanReason): string => {
    switch (r.kind) {
      case "role":
        return t("whoCan.reasons.role", { role: r.roleName });
      case "grant":
        return r.byName
          ? t("whoCan.reasons.grant", { name: r.byName, date: formatDate(r.at, i18n.language) })
          : t("whoCan.reasons.grantByHand", { date: formatDate(r.at, i18n.language) });
      case "department":
        return t("whoCan.reasons.department", { department: r.departmentName });
      case "full_admin":
        return t("whoCan.reasons.fullAdmin");
    }
  };
}

export interface PickerOption {
  id: string;
  label: string;
  /** Testo in tono minore accanto (il nome del progetto accanto al codice). */
  detail?: string;
  /** Il gruppo (titolo) sotto cui sta; le voci senza gruppo vanno in testa. */
  group?: string;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Un menu in linea nella frase (20 px, 600): un bottone che apre una
 * casella di ricerca `combobox` con l'elenco sotto. Frecce e Invio
 * scelgono, Esc chiude e rende il fuoco al bottone, un clic fuori chiude.
 */
export function InlinePicker({
  label,
  value,
  placeholder,
  options,
  searchLabel,
  onSelect,
  defaultOpen = false,
  valueDetail,
}: {
  /** Il nome del menu per chi non lo vede («Action»). */
  label: string;
  /** Ciò che si legge nella frase; `null` = non scelto. */
  value: string | null;
  /** In tono minore dopo il valore (il nome del progetto dopo il codice). */
  valueDetail?: string;
  placeholder: string;
  options: PickerOption[];
  searchLabel: string;
  onSelect: (id: string) => void;
  /** Aperto all'arrivo (⌘K senza progetto corrente apre il menu dei progetti). */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [find, setFind] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const needle = fold(find.trim());
  const shown = options.filter((o) => fold(`${o.label} ${o.detail ?? ""}`).includes(needle));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (restore: boolean) => {
    setOpen(false);
    setFind("");
    setActive(0);
    if (restore) button.current?.focus();
  };
  const choose = (i: number) => {
    const o = shown[i];
    if (!o) return;
    onSelect(o.id);
    close(true);
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(shown.length - 1, a + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        return;
      case "Enter":
        e.preventDefault();
        choose(active);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
  }

  let lastGroup: string | undefined;
  return (
    <span ref={wrap} className="relative inline-block">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${value ? [value, valueDetail].filter(Boolean).join(" ") : placeholder}`}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`inline-flex items-baseline gap-1 rounded-sm border-b border-dashed border-rule-strong font-semibold transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink ${value ? "text-ink" : "text-ink-muted"}`}
      >
        {value ?? placeholder}
        {value && valueDetail && (
          <span className="font-normal text-ink-muted">{valueDetail}</span>
        )}
        <span className="self-center text-ink-muted">
          <Chevron />
        </span>
      </button>
      {open && (
        <span className="menu-enter absolute top-full left-0 z-30 mt-1 flex w-80 max-w-[calc(100vw-48px)] flex-col rounded-lg border border-rule-strong bg-surface p-1.5 text-md font-normal shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown[active] ? optionId(active) : undefined}
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="mb-1 h-8 rounded-md border border-rule bg-transparent px-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-rule-strong"
          />
          <ul id={listId} role="listbox" aria-label={label} className="max-h-80 overflow-y-auto">
            {shown.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-ink-muted">{t("whoCan.page.noMatch")}</li>
            )}
            {shown.map((o, i) => {
              const heading = o.group !== lastGroup && o.group ? o.group : null;
              lastGroup = o.group;
              return (
                <li key={o.id} role="presentation">
                  {heading && (
                    <span
                      aria-hidden="true"
                      className="heading-group block px-2 pt-2 pb-1 not-first:mt-1 not-first:border-t not-first:border-rule"
                    >
                      {heading}
                    </span>
                  )}
                  <span
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onPointerMove={() => setActive(i)}
                    onClick={() => choose(i)}
                    className={`flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-md ${i === active ? "bg-ink/10 text-ink" : "text-ink"}`}
                  >
                    <span className="min-w-0 truncate">{o.label}</span>
                    {o.detail && (
                      <span className="min-w-0 truncate text-sm text-ink-muted">{o.detail}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </span>
      )}
    </span>
  );
}

/** Il menu delle azioni: il catalogo `ACTIONS` in parole, a gruppi come la tabella dei permessi. */
export function useActionOptions(): PickerOption[] {
  const { t } = useTranslation();
  // Prima le azioni di progetto, poi quelle d'istanza; dentro, i gruppi nel loro ordine.
  const placed = ACTIONS.map((a, i) => {
    const groups = groupsFor(a.scope);
    const at = groups.findIndex((g) => g.permissions.includes(a.permission));
    return { a, i, key: groups[at]?.key, rank: (a.scope === "project" ? 0 : 100) + at };
  });
  return placed
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map(({ a, key }) => ({
      id: a.id,
      label: t(a.labelKey),
      group: key ? t(`whoCan.groups.${key}`) : undefined,
    }));
}

/** Lo scheletro della risposta: quattro righe sotto la frase (shape §5). */
function AnswerSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="skeleton-breathe mt-6">
      <span role="status" className="sr-only">
        {label}
      </span>
      <span className="block h-3 w-20 rounded-sm bg-ink/8" />
      {[60, 45, 52, 38].map((w, i) => (
        <div key={i} className="flex h-10 items-center gap-3 border-b border-rule">
          <span className="size-7 rounded-full bg-ink/8" />
          <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

export function WhoCanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Search;
  const choices = useWhoCanChoices();
  const mode: "who" | "what" =
    search.view === "what" || (search.view !== "who" && !!search.person) ? "what" : "who";
  const set = (patch: Partial<Search>) =>
    void navigate({ to: ".", search: (prev: Search) => ({ ...prev, ...patch }), replace: true });

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[880px]">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">
          {t("admin.sections.who-can")}
        </h1>
        <p className="mt-2 max-w-[72ch] text-md text-pretty text-ink-muted">
          {t("whoCan.page.intro")}
        </p>
        <div
          role="group"
          aria-label={t("whoCan.page.modes")}
          className="mt-6 inline-flex rounded-md border border-rule p-0.5"
        >
          {(["who", "what"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => set({ view: m })}
              className="h-7 rounded-[5px] px-3 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink aria-pressed:bg-ink/10 aria-pressed:text-ink"
            >
              {t(m === "who" ? "whoCan.page.modeWho" : "whoCan.page.modeWhat")}
            </button>
          ))}
        </div>
        {choices.isError ? (
          <div className="mt-4">
            <PageError message={t("whoCan.page.error")} onRetry={() => void choices.refetch()} />
          </div>
        ) : !choices.data ? (
          <AnswerSkeleton label={t("whoCan.page.loading")} />
        ) : mode === "who" ? (
          <WhoQuestion search={search} choices={choices.data} onChange={set} />
        ) : (
          <WhatQuestion search={search} choices={choices.data} onChange={set} />
        )}
      </div>
    </section>
  );
}

type Choices = NonNullable<ReturnType<typeof useWhoCanChoices>["data"]>;

/** «Who can [action] in [project]?» e la risposta. */
function WhoQuestion({
  search,
  choices,
  onChange,
}: {
  search: Search;
  choices: Choices;
  onChange: (patch: Partial<Search>) => void;
}) {
  const { t } = useTranslation();
  const actions = useActionOptions();
  const action = search.action ? actionById(search.action) : undefined;
  // R-G5: un progetto che chi guarda non vede è come uno che non esiste.
  const project = choices.projects.find((p) => p.code === search.project);
  const instance = action?.scope === "instance";
  const projectId = instance ? null : (project?.projectId ?? null);
  const ready = !!action && (instance || !!project);
  const answer = useWhoCan(action?.id, projectId, ready);
  const actionWords = action ? t(action.labelKey) : null;
  const projectOptions = choices.projects.map((p) => ({
    id: p.code,
    label: p.code,
    detail: p.name,
  }));

  const actionPicker = (
    <InlinePicker
      label={t("whoCan.page.actionMenu")}
      value={actionWords}
      placeholder={t("whoCan.page.chooseAction")}
      options={actions}
      searchLabel={t("whoCan.page.findAction")}
      onSelect={(id) => onChange({ action: id, view: "who" })}
    />
  );
  const projectPicker = (
    <InlinePicker
      label={t("whoCan.page.projectMenu")}
      value={project?.code ?? null}
      valueDetail={project?.name}
      placeholder={t("whoCan.page.chooseProject")}
      options={projectOptions}
      searchLabel={t("whoCan.page.findProject")}
      onSelect={(code) => onChange({ project: code, view: "who" })}
      defaultOpen={!!action && !instance && search.project === undefined}
    />
  );

  return (
    <>
      <p data-question="who" className="mt-4 text-xl font-semibold text-pretty text-ink">
        {instance ? (
          <Trans i18nKey="whoCan.page.whoSentenceInstance" components={{ action: actionPicker }} />
        ) : (
          <Trans
            i18nKey="whoCan.page.whoSentence"
            components={{ action: actionPicker, project: projectPicker }}
          />
        )}
      </p>
      {!action ? (
        <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickAction")}</p>
      ) : !instance && !project ? (
        <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickProject")}</p>
      ) : (
        <WhoAnswer
          answer={answer.data}
          pending={answer.isPending}
          error={answer.isError}
          onRetry={() => void answer.refetch()}
          actionWords={actionWords!}
          code={project?.code ?? null}
        />
      )}
    </>
  );
}

function WhoAnswer({
  answer,
  pending,
  error,
  onRetry,
  actionWords,
  code,
}: {
  answer: WhoCanView | undefined;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  actionWords: string;
  code: string | null;
}) {
  const { t } = useTranslation();
  const reasonWords = useReasonWords();
  if (error) return <PageError message={t("whoCan.page.error")} onRetry={onRetry} />;
  if (pending || !answer) return <AnswerSkeleton label={t("whoCan.page.loading")} />;
  if (!answer.visible)
    return <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickProject")}</p>;
  return (
    <div aria-live="polite" className="mt-6">
      {answer.people.length === 0 ? (
        <p className="text-md text-ink">
          {code
            ? t("whoCan.page.none", { action: actionWords, code })
            : t("whoCan.page.noneInstance", { action: actionWords })}
        </p>
      ) : (
        <>
          <p className="text-lg font-semibold text-ink">
            {t("whoCan.page.count", { count: answer.people.length })}
          </p>
          <ul
            aria-label={t("whoCan.page.answers", { action: actionWords })}
            className="@container mt-2 border-t border-rule"
          >
            {answer.people.map((p) => (
              <li
                key={p.personId}
                data-who-row={p.personId}
                className="flex min-h-10 items-center gap-3 border-b border-rule py-1.5"
              >
                <AdminAvatar initials={p.initials} />
                <span className="flex min-w-0 flex-1 flex-col @[560px]:flex-row @[560px]:items-baseline @[560px]:gap-3">
                  <Link
                    to="/admin/people/$personId"
                    params={{ personId: p.personId }}
                    className="shrink-0 text-md font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {p.name}
                  </Link>
                  <span className="min-w-0 text-sm text-pretty text-ink-muted">
                    {p.reasons.map(reasonWords).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div data-claude-row className="mt-4 border-t border-rule pt-3">
        <p className="text-md text-ink">
          <span className="font-medium">Claude</span> — {t("whoCan.page.claudeLine")}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">
          {answer.claude.allowed
            ? t("whoCan.page.claudeCan", { action: actionWords })
            : t("whoCan.page.claudeCant", { action: actionWords })}
        </p>
      </div>
    </div>
  );
}

/** «What can [person] do in [project ▾ | the whole instance]?» e la risposta. */
function WhatQuestion({
  search,
  choices,
  onChange,
}: {
  search: Search;
  choices: Choices;
  onChange: (patch: Partial<Search>) => void;
}) {
  const { t } = useTranslation();
  const personOptions: PickerOption[] = [
    ...choices.people.map((p) => ({ id: p.personId, label: p.name })),
    { id: CLAUDE, label: "Claude" },
  ];
  const person = personOptions.find((p) => p.id === search.person);
  // Senza progetto (o con `instance`) la domanda è sull'istanza intera.
  const project =
    search.project && search.project !== INSTANCE_ONLY
      ? choices.projects.find((p) => p.code === search.project)
      : undefined;
  const invisibleProject =
    !!search.project && search.project !== INSTANCE_ONLY && !project;
  const projectId = project?.projectId ?? null;
  const answer = useWhatCan(person && !invisibleProject ? person.id : undefined, projectId);
  const projectOptions: PickerOption[] = [
    { id: INSTANCE_ONLY, label: t("whoCan.page.wholeInstance") },
    ...choices.projects.map((p) => ({ id: p.code, label: p.code, detail: p.name })),
  ];

  return (
    <>
      <p data-question="what" className="mt-4 text-xl font-semibold text-pretty text-ink">
        <Trans
          i18nKey="whoCan.page.whatSentence"
          components={{
            person: (
              <InlinePicker
                label={t("whoCan.page.personMenu")}
                value={person?.label ?? null}
                placeholder={t("whoCan.page.choosePerson")}
                options={personOptions}
                searchLabel={t("whoCan.page.findPerson")}
                onSelect={(id) => onChange({ person: id, view: "what" })}
              />
            ),
            project: (
              <InlinePicker
                label={t("whoCan.page.projectMenu")}
                value={
                  invisibleProject
                    ? null
                    : project
                      ? project.code
                      : t("whoCan.page.wholeInstance")
                }
                valueDetail={project?.name}
                placeholder={t("whoCan.page.chooseProject")}
                options={projectOptions}
                searchLabel={t("whoCan.page.findProject")}
                onSelect={(code) => onChange({ project: code, view: "what" })}
              />
            ),
          }}
        />
      </p>
      {!person ? (
        <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickPerson")}</p>
      ) : invisibleProject ? (
        <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickProject")}</p>
      ) : answer.isError ? (
        <PageError message={t("whoCan.page.error")} onRetry={() => void answer.refetch()} />
      ) : answer.isPending ? (
        <AnswerSkeleton label={t("whoCan.page.loading")} />
      ) : (
        <WhatAnswer answer={answer.data} />
      )}
    </>
  );
}

function WhatAnswer({ answer }: { answer: WhatCanView }) {
  const { t, i18n } = useTranslation();
  const words = usePermissionWords();
  const hint = usePermissionHint();
  const reasonWords = useReasonWords();
  const [showMissing, setShowMissing] = useState(false);
  if (!answer.visible)
    return <p className="mt-6 text-md text-ink-muted">{t("whoCan.page.pickPerson")}</p>;
  const all = answer.groups.flatMap((g) => g.permissions);
  const held = all.filter((p) => p.held);

  if (answer.isClaude)
    return (
      <div aria-live="polite" className="mt-6">
        <p className="text-lg font-semibold text-ink">{t("whoCan.page.claudeWhat")}</p>
        {(["can", "never"] as const).map((side) => {
          const list = all.filter((p) => p.held === (side === "can"));
          if (list.length === 0) return null;
          return (
            <section key={side} className="mt-5">
              <h2 className="heading-group border-b border-rule pb-1.5">
                {t(`whoCan.page.${side}`)}
              </h2>
              <ul>
                {list.map((p) => (
                  <ReadRow
                    key={p.permission}
                    permission={p.permission}
                    name={capitalized(words(p.permission), i18n.language)}
                    hint={hint(p.permission)}
                    faint={side === "never"}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    );

  return (
    <div aria-live="polite" className="mt-6">
      {answer.member === false && (
        <p className="mb-4 text-md text-ink">
          {held.length > 0
            ? t("whoCan.page.notMemberButAdmin", { name: answer.name, code: answer.projectCode })
            : t("whoCan.page.notMember", { name: answer.name, code: answer.projectCode })}
        </p>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-lg font-semibold text-ink">
          {held.length === 0
            ? t("whoCan.page.nothingHeld", { name: answer.name })
            : t("whoCan.page.permissionsOf", { name: answer.name })}
        </p>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <Switch
            checked={showMissing}
            label={t("whoCan.page.alsoCant", { name: answer.name })}
            onChange={setShowMissing}
          />
          <span aria-hidden="true">{t("whoCan.page.alsoCant", { name: answer.name })}</span>
        </label>
      </div>
      {answer.groups.map((g) => {
        const rows = g.permissions.filter((p) => p.held || showMissing);
        if (rows.length === 0) return null;
        return (
          <section key={g.groupKey} className="mt-5">
            <h2 className="heading-group border-b border-rule pb-1.5">
              {t(`whoCan.groups.${g.groupKey}`)}
            </h2>
            <ul className="@container">
              {rows.map((p) => (
                <ReadRow
                  key={p.permission}
                  permission={p.permission}
                  name={capitalized(words(p.permission), i18n.language)}
                  hint={hint(p.permission)}
                  source={p.held ? p.reasons.map(reasonWords).join(" · ") : undefined}
                  faint={!p.held}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Una riga di sola lettura: nome · frase · a destra la fonte (in `ink-faint`, senza fonte, ciò che manca). */
function ReadRow({
  permission,
  name,
  hint,
  source,
  faint = false,
}: {
  permission: string;
  name: string;
  hint: string;
  source?: ReactNode;
  faint?: boolean;
}) {
  return (
    <li
      title={permission}
      data-permission={permission}
      data-held={!faint}
      className="flex min-h-9 flex-col gap-0.5 border-b border-rule py-1.5 last:border-b-0 @min-[720px]:flex-row @min-[720px]:items-baseline @min-[720px]:gap-4"
    >
      <span
        className={`text-md @min-[720px]:w-52 @min-[720px]:shrink-0 ${faint ? "text-ink-faint" : "text-ink"}`}
      >
        {name}
      </span>
      <span
        className={`min-w-0 flex-1 text-sm text-pretty ${faint ? "text-ink-faint" : "text-ink-muted"}`}
      >
        {hint}
      </span>
      {source && (
        <span className="shrink-0 text-xs text-ink-muted @min-[720px]:max-w-[28ch] @min-[720px]:text-right">
          {source}
        </span>
      )}
    </li>
  );
}
