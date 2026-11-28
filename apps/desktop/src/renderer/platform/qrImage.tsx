// Il QR del TOTP (cassaforte nel browser, revisione I-4): un `<img>` con lo
// SVG del server in un `data:`, non un `innerHTML`. Un'immagine non esegue
// niente e non è un punto dei Trusted Types; `img-src 'self' data:` la
// ammette. Lo SVG è quello del server (`otpauth` in un QR, nero su bianco).

export function QrImage({ svg, label, className }: { svg: string; label: string; className?: string }) {
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={label}
      className={className}
      draggable={false}
    />
  );
}
