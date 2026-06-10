import type { Breadcrumb } from "@stubwise/shared";

/** Capienza di default: allineata al max accettato da ErrorEvent.breadcrumbs. */
const DEFAULT_MAX = 30;

/**
 * Ring buffer di breadcrumb: oltre la capienza, il più vecchio viene scartato.
 */
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];

  constructor(private readonly maxSize: number = DEFAULT_MAX) {}

  add(breadcrumb: Breadcrumb): void {
    this.items.push(breadcrumb);
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
  }

  /** Copia indipendente: mutazioni successive del buffer non toccano lo snapshot. */
  snapshot(): Breadcrumb[] {
    return [...this.items];
  }
}
