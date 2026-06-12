import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { getAccountBranches } from "../lib/api";
import { SelectField, TextField } from "./field";

interface BranchSelectProps {
  /** Account git che fornisce le credenziali per elencare i branch. */
  accountId?: string;
  /** Repo da interrogare, nel formato owner/repo. */
  repoFullName?: string;
  /** Branch attualmente scelto (controllato dal genitore). */
  value: string;
  onChange: (branch: string) => void;
  /** Id del campo (utile quando ci sono più istanze in pagina). */
  id?: string;
}

/**
 * Select dei branch di un repository, popolato via provider API
 * ({@link getAccountBranches}). Condiviso fra wizard di creazione e form di
 * modifica per tenerli coerenti.
 *
 * - Con `accountId` e `repoFullName` presenti carica l'elenco e mostra un
 *   `<select>` che preseleziona `value`. Se `value` non è fra i branch tornati,
 *   lo si include comunque come opzione per non perderlo. Il `defaultBranch`
 *   dell'API è solo un suggerimento: preseleziona il branch quando il genitore
 *   non ne ha ancora uno, senza mai sovrascrivere un `value` esistente.
 * - Durante il fetch mostra uno stato di caricamento.
 * - Su errore di fetch, o se account/repo non sono determinabili, ricade su un
 *   input testuale (così l'utente non resta mai bloccato) con una nota.
 */
export function BranchSelect({
  accountId,
  repoFullName,
  value,
  onChange,
  id = "branch-select",
}: BranchSelectProps) {
  const enabled = !!accountId && !!repoFullName;

  const branchesQuery = useQuery({
    queryKey: ["git-accounts", "detail", accountId, "branches", repoFullName],
    queryFn: () => getAccountBranches(accountId!, repoFullName!),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  // Suggerimento del provider: preseleziona il branch solo se il genitore non
  // ne ha ancora uno (così non si sovrascrive una scelta esistente).
  const suggested = branchesQuery.data?.defaultBranch ?? undefined;
  useEffect(() => {
    if (value === "" && suggested) onChange(suggested);
  }, [value, suggested, onChange]);

  const branches = branchesQuery.data?.branches ?? [];
  // Il branch scelto potrebbe non essere nell'elenco: lo si include comunque
  // come opzione per non perderlo.
  const options = useMemo(() => {
    const set = new Set(branches);
    if (value) set.add(value);
    return [...set];
  }, [branches, value]);

  // Fallback a input testuale: account/repo non determinabili o fetch fallito.
  if (!enabled || branchesQuery.isError) {
    return (
      <div className="flex flex-col gap-1.5">
        <TextField
          id={id}
          label="Branch di default"
          required
          placeholder="main"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {branchesQuery.isError && (
          <p className="font-mono text-[11px] text-fg-faint">
            // impossibile caricare i branch: inseriscilo manualmente.
          </p>
        )}
      </div>
    );
  }

  if (branchesQuery.isLoading) {
    return <p className="font-mono text-[12px] text-fg-faint">// caricamento branch…</p>;
  }

  return (
    <SelectField
      id={id}
      label="Branch di default"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options.map((b) => ({ value: b, label: b }))}
    />
  );
}
