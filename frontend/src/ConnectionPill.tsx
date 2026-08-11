import type { ConnectionState } from "./useRealtimeConversation";

interface Meta {
  /** Maps onto a .pill--* variant in styles/base.css. */
  variant: "default" | "accent" | "success" | "danger";
  label: string;
  /** Only live states breathe — a static dot would read the same as "idle". */
  pulse?: boolean;
}

const CONNECTION_META: Record<ConnectionState, Meta> = {
  idle: { variant: "default", label: "Not connected" },
  connecting: { variant: "accent", label: "Connecting", pulse: true },
  connected: { variant: "success", label: "Live", pulse: true },
  ending: { variant: "accent", label: "Wrapping up", pulse: true },
  ended: { variant: "default", label: "Conversation ended" },
  error: { variant: "danger", label: "Connection error" },
};

/** Single source of truth for how a connection state is named and coloured. */
export function ConnectionPill({ state }: { state: ConnectionState }) {
  const { variant, label, pulse } = CONNECTION_META[state];

  return (
    <span
      className={variant === "default" ? "pill" : `pill pill--${variant}`}
      role="status"
      aria-live="polite"
    >
      <span className={pulse ? "pill__dot pill__dot--pulse" : "pill__dot"} aria-hidden="true" />
      {label}
    </span>
  );
}
