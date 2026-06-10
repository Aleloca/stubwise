/**
 * Wordmark di Stubwise: minuscolo, mono, con cursore ambra lampeggiante.
 * È la firma visiva del prodotto — usato in login, setup e sidebar.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-mono font-semibold tracking-tight select-none ${className}`}>
      <span aria-hidden="true" className="mr-2 inline-block size-[0.62em] translate-y-px bg-signal" />
      stubwise
      <span aria-hidden="true" className="animate-blink text-signal">
        _
      </span>
    </span>
  );
}
