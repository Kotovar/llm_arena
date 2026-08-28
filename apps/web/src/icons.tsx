import type { ReactNode } from "react";

/**
 * Один набор иконок вместо текстовых глифов: ✕, →, ↗ и ✓ рисовались разным шрифтом
 * в разном кегле и не совпадали друг с другом по весу линии.
 */
function Icon({ children }: { children: ReactNode }) {
  return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>;
}

export function CloseIcon() {
  return <Icon><path d="M4 4l8 8M12 4l-8 8" /></Icon>;
}

export function ArrowRightIcon() {
  return <Icon><path d="M3 8h10M9 4l4 4-4 4" /></Icon>;
}

export function ArrowLeftIcon() {
  return <Icon><path d="M13 8H3M7 4L3 8l4 4" /></Icon>;
}

export function ExternalIcon() {
  return <Icon><path d="M6 3h7v7M13 3L6.5 9.5M11 10.5V13H3V5h2.5" /></Icon>;
}

export function CheckIcon() {
  return <Icon><path d="M3 8.5l3.5 3.5L13 5" /></Icon>;
}
