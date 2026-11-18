import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { PATHS } from "../paths";

/**
 * Syncro mark: a squared-off "S" route joining an outlined node (bottom left)
 * to a filled accent node (top right). Proportions follow the approved icon
 * artwork (viewBox cropped to the artwork); colors come from the theme tokens
 * so it matches in Paper and Ink.
 */
export function SyncroMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="216 232 576 576" aria-hidden="true" focusable="false">
      <path
        d="M645 305.5H291.5V512H732.5V718.5H395"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="45"
        strokeLinejoin="miter"
      />
      <rect x="238.5" y="651.5" width="134" height="134" fill="none" stroke="var(--ink)" strokeWidth="45" />
      <rect x="645" y="232" width="147" height="147" fill="var(--ac)" />
    </svg>
  );
}

/** Mark and the serif "Syncro" name, sized and spaced as in the approved logo artwork. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <SyncroMark size={compact ? 20 : 22} />
      <span className={`font-serif ${compact ? "text-[21px]" : "text-[24px]"}`}>Syncro</span>
    </span>
  );
}

const NAV = [
  { n: "01", label: "Repositories", to: PATHS.repositories },
  { n: "02", label: "Activity", to: PATHS.activity },
  { n: "03", label: "Destinations", to: PATHS.destinations },
  { n: "04", label: "Account", to: PATHS.account },
] as const;

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? "text-ac font-semibold" : "text-ink";
}

export function LegalLinks() {
  return (
    <p className="flex gap-3 text-[12px] text-mu">
      <Link className="text-action" to={PATHS.privacy}>
        Privacy
      </Link>
      <Link className="text-action" to={PATHS.terms}>
        Terms
      </Link>
    </p>
  );
}

/** Signed-in layout: sidebar on wide screens, top bar and bottom tabs on mobile. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden shrink-0 flex-col justify-between border-r border-ru px-[18px] py-6 lg:flex lg:w-[176px] xl:w-[220px] xl:px-6 xl:py-7">
        <div>
          <Link to={PATHS.repositories} aria-label="Syncro home">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="mt-8">
            <ul>
              {NAV.map((item) => (
                <li key={item.to} className="border-b border-ru">
                  <NavLink to={item.to} className={(s) => `flex gap-3 py-2.5 ${navClass(s)}`}>
                    <span className="font-mono text-[12px] text-mu">{item.n}</span>
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <LegalLinks />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-ru px-5 py-4 lg:hidden">
          <Link to={PATHS.repositories} aria-label="Syncro home">
            <Wordmark compact />
          </Link>
        </div>
        <main className="flex-1 px-5 pb-28 pt-5 sm:px-7 lg:px-7 lg:pb-10 lg:pt-6 xl:px-10 xl:pt-[30px]">
          {children}
        </main>
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-ru bg-bg lg:hidden"
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex min-h-[52px] flex-col items-center justify-center border-t-2 text-[11px] ${
                isActive ? "border-ac text-ac font-semibold" : "border-transparent text-ink"
              }`
            }
          >
            <span className="font-mono text-[11px] text-mu">{item.n}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Minimal layout for pages outside the signed-in app (sign-in, legal, callbacks). */
export function PlainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-[980px] flex-col px-5 py-6 sm:px-10">
      <header className="border-b border-ink pb-4">
        <Link to={PATHS.home} aria-label="Syncro home">
          <Wordmark />
        </Link>
      </header>
      <main className="flex-1 py-8">{children}</main>
      <footer className="border-t border-ru pt-4">
        <LegalLinks />
      </footer>
    </div>
  );
}
