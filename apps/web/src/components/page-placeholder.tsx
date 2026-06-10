interface PagePlaceholderProps {
  title: string;
  description: string;
}

/** Segnaposto per le pagine in arrivo nei task successivi (16–18). */
export function PagePlaceholder({ title, description }: PagePlaceholderProps) {
  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-fg-muted">{description}</p>
      </header>
      <div className="mt-8 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
        <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
          // in costruzione
        </p>
      </div>
    </div>
  );
}
