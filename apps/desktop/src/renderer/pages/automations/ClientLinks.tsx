import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useClientLinks,
  useProjects,
  useRemoveClientLink,
  useSetClientLink,
} from "../../data/queries";
import type { ClientLinkView } from "../../data/types";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import {
  MenuButton,
  dangerSolidButton,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../tasks/controls";
import { MoreGlyph } from "./glyphs";
import { codeClass } from "./shared";

// «Clients and projects» (shape automation-sources.md §6): il registro delle
// corrispondenze con cui un'automazione generale trova il progetto del
// cliente. Una riga che punta a un progetto che chi guarda non vede dice «A
// project you can't see» e si può solo rimuovere ([A 12]). «Add client» è
// una riga in modifica in testa alla tabella ([A 11]).

/** Da quante righe compare la ricerca sopra la tabella. */
const SEARCH_FROM = 20;

const cols =
  "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_40px] items-center gap-3";

/** La chiave come la riconoscono le sorgenti: un dominio email, o un id del CRM. */
function keyWords(key: string, t: (k: string, o?: Record<string, unknown>) => string) {
  return key.includes(".")
    ? t("automations.clients.domain", { key })
    : t("automations.clients.crmId", { key });
}

function ProjectSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const { t } = useTranslation();
  const projects = [...(useProjects().data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  return (
    <select
      id={id}
      aria-label={t("automations.clients.project")}
      className={`${inputClass} h-8`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t("automations.clients.pickProject")}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code} · {p.name}
        </option>
      ))}
    </select>
  );
}

function AddRow({ links, onDone }: { links: ClientLinkView[]; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSetClientLink();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const keyId = useId();
  const clash = links.find((l) => l.clientKey === key.trim().toLowerCase());
  const project = useProjects().data?.find((p) => p.id === clash?.projectId);
  const ok = name.trim() !== "" && key.trim() !== "" && projectId !== "" && !clash;
  return (
    <div data-add-client className={`${cols} border-b border-rule bg-ink/4 px-2 py-2`}>
      <input
        autoFocus
        aria-label={t("automations.clients.client")}
        placeholder={t("automations.clients.client")}
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <input
          id={keyId}
          aria-label={t("automations.clients.key")}
          placeholder={t("automations.clients.keyPlaceholder")}
          className={inputClass}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {clash && (
          <span role="alert" className="text-xs text-critical">
            {t("automations.clients.clash", {
              key: clash.clientKey,
              code: project?.code ?? t("automations.clients.hiddenShort"),
            })}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <ProjectSelect value={projectId} onChange={setProjectId} />
      </div>
      <span />
      <div className="col-span-4 flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onDone}>
          {t("automations.actions.cancel")}
        </button>
        <button
          type="button"
          className={`${primaryButton} disabled:opacity-40`}
          disabled={!ok || save.isPending}
          onClick={() =>
            save.mutate(
              { clientKey: key, clientName: name, projectId },
              {
                onSuccess: () => {
                  onDone();
                  toast.show(t("automations.toast.clientAdded", { client: name.trim() }));
                },
                onError: () => toast.error(t("automations.toast.clientError")),
              },
            )
          }
        >
          {t("automations.clients.add")}
        </button>
      </div>
    </div>
  );
}

function LinkRow({ link }: { link: ClientLinkView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const project = useProjects().data?.find((p) => p.id === link.projectId);
  const save = useSetClientLink();
  const remove = useRemoveClientLink();
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <li
      data-client-link={link.clientKey}
      aria-label={t("automations.clients.rowLabel", {
        client: link.clientName,
        project:
          link.projectVisible && project
            ? `${project.code} ${project.name}`
            : t("automations.clients.hidden"),
      })}
      className={`${cols} group min-h-10 border-b border-rule px-2 hover:bg-ink/4`}
    >
      <span className="truncate text-md text-ink">{link.clientName}</span>
      <span className="truncate text-sm text-ink-muted">{keyWords(link.clientKey, t)}</span>
      {changing ? (
        <ProjectSelect
          value={link.projectId}
          onChange={(projectId) =>
            projectId &&
            save.mutate(
              { clientKey: link.clientKey, clientName: link.clientName, projectId },
              {
                onSuccess: () => {
                  setChanging(false);
                  toast.show(t("automations.toast.clientChanged", { client: link.clientName }));
                },
                onError: () => toast.error(t("automations.toast.clientError")),
              },
            )
          }
        />
      ) : link.projectVisible && project ? (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={codeClass}>{project.code}</span>
          <span className="truncate text-sm text-ink-muted">{project.name}</span>
        </span>
      ) : (
        <span data-hidden-project className="text-sm text-ink-faint">
          {t("automations.clients.hidden")}
        </span>
      )}
      <MenuButton
        menuLabel={t("automations.clients.menu", { client: link.clientName })}
        ariaLabel={t("automations.clients.menu", { client: link.clientName })}
        align="right"
        className={`${quietButton} h-7 w-7 justify-center px-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100`}
        label={<MoreGlyph />}
      >
        {(close) => (
          <MenuGroup>
            {link.projectVisible && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  close();
                  setChanging(true);
                }}
              >
                {t("automations.clients.change")}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${itemClass} text-critical`}
              onClick={() => {
                close();
                setRemoving(true);
              }}
            >
              {t("automations.clients.remove")}
            </button>
          </MenuGroup>
        )}
      </MenuButton>
      {removing && (
        <Dialog
          title={t("automations.clients.removeTitle", { client: link.clientName })}
          width={400}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setRemoving(false)}>
                {t("automations.actions.cancel")}
              </button>
              <button
                type="button"
                className={dangerSolidButton}
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(link.clientKey, {
                    onSuccess: () => {
                      setRemoving(false);
                      toast.show(t("automations.toast.clientRemoved", { client: link.clientName }));
                    },
                    onError: () => toast.error(t("automations.toast.clientError")),
                  })
                }
              >
                {t("automations.clients.remove")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{t("automations.clients.removeBody")}</p>
          {!link.projectVisible && (
            <p className="text-sm text-ink-muted">{t("automations.clients.removeHidden")}</p>
          )}
        </Dialog>
      )}
    </li>
  );
}

export function ClientLinks() {
  const { t } = useTranslation();
  const links = useClientLinks();
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const all = [...(links.data ?? [])].sort((a, b) => a.clientName.localeCompare(b.clientName));
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((l) => l.clientName.toLowerCase().includes(needle) || l.clientKey.includes(needle))
    : all;
  return (
    <section aria-labelledby="client-links" className="border-t border-rule pt-5 pb-7">
      <div className="flex items-center gap-3 pb-1">
        <h2 id="client-links" className="text-xl font-semibold text-ink">
          {t("automations.clients.title")}
        </h2>
        <button
          type="button"
          className={`${secondaryButton} ml-auto`}
          onClick={() => setAdding(true)}
          disabled={adding}
        >
          {t("automations.clients.addClient")}
        </button>
      </div>
      <p className="pb-3 text-sm text-ink-muted">{t("automations.clients.intro")}</p>
      {links.isError ? (
        <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
          <p className="text-md text-ink">{t("automations.errors.loadClients")}</p>
          <button type="button" className={secondaryButton} onClick={() => void links.refetch()}>
            {t("automations.actions.retry")}
          </button>
        </div>
      ) : links.data === undefined ? (
        <PageSkeleton rows={3} />
      ) : (
        <>
          {all.length >= SEARCH_FROM && (
            <input
              type="search"
              aria-label={t("automations.clients.search")}
              placeholder={t("automations.clients.search")}
              className={`${inputClass} mb-2 max-w-80`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          <div>
            <div
              aria-hidden="true"
              className={`${cols} border-b border-rule px-2 pb-1.5 text-xs font-semibold text-ink-muted`}
            >
              <span>{t("automations.clients.client")}</span>
              <span>{t("automations.clients.key")}</span>
              <span>{t("automations.clients.project")}</span>
              <span />
            </div>
            {adding && <AddRow links={all} onDone={() => setAdding(false)} />}
            {all.length === 0 && !adding ? (
              <div className="flex flex-col items-start gap-2 py-4">
                <p className="text-md text-ink">{t("automations.clients.empty")}</p>
                <button type="button" className={secondaryButton} onClick={() => setAdding(true)}>
                  {t("automations.clients.addClient")}
                </button>
              </div>
            ) : (
              <ul aria-label={t("automations.clients.title")}>
                {shown.map((l) => (
                  <LinkRow key={l.clientKey} link={l} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <p className="pt-3 text-xs text-ink-muted">{t("automations.clients.note")}</p>
    </section>
  );
}
