/**
 * The single source for status rendering: a 12x12 glyph followed by a text
 * label, so status is never conveyed by color alone.
 */

export type StatusKind = "ok" | "failed" | "pending" | "planned" | "ignored";

const COLOR: Record<StatusKind, string> = {
  ok: "text-ok",
  failed: "text-er",
  pending: "text-wa",
  planned: "text-mu",
  ignored: "text-mu",
};

function Glyph({ kind }: { kind: StatusKind }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    "aria-hidden": true,
    focusable: false,
    "data-glyph": kind,
    className: "shrink-0",
  } as const;
  switch (kind) {
    case "ok":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common}>
          <rect x="1.25" y="1.25" width="9.5" height="9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "pending":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.25a4.75 4.75 0 0 1 0 9.5z" fill="currentColor" />
        </svg>
      );
    case "planned":
      return (
        <svg {...common}>
          <circle
            cx="6"
            cy="6"
            r="4.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2 2"
          />
        </svg>
      );
    case "ignored":
      return (
        <svg {...common}>
          <path d="M3 6h6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

export function StatusMark({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium ${COLOR[kind]}`}>
      <Glyph kind={kind} />
      <span>{label}</span>
    </span>
  );
}
