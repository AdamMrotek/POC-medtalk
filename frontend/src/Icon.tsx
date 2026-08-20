import type { LucideIcon, LucideProps } from "lucide-react";

interface Props extends Omit<LucideProps, "ref" | "children"> {
  /** The Lucide component to render, e.g. `Check`. */
  as: LucideIcon;
}

/**
 * The only way an icon enters this app.
 *
 * Two things are centralised here rather than repeated at ~10 call sites:
 * `strokeWidth`, because Lucide's default of 2 reads heavy beside this app's
 * 1px hairline borders, and `aria-hidden`, because every icon we render sits
 * next to a text label that already says the same thing. An icon that is the
 * sole carrier of its meaning must not use this component — give it a label.
 *
 * Colour is deliberately absent: `.icon` inherits `currentColor`, so an icon
 * takes on whichever token names its role at the call site and needs no
 * dark-mode handling of its own.
 */
export function Icon({ as: Glyph, size = 16, className, ...rest }: Props) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    />
  );
}
