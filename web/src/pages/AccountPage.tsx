import { useId } from "react";
import { useAuth } from "../auth/auth-context";
import { LegalLinks, Shell } from "../components/Shell";
import { PageHeader, SectionHeader } from "../components/ui";
import { useThemePreference, type ThemePreference } from "../lib/theme";

const THEMES: Array<{ value: ThemePreference; label: string; note: string }> = [
  { value: "system", label: "System", note: "Follows your device" },
  { value: "light", label: "Paper", note: "Light" },
  { value: "dark", label: "Ink", note: "Dark" },
];

export function AccountPage() {
  const auth = useAuth();
  const [theme, setTheme] = useThemePreference();
  const groupId = useId();

  return (
    <Shell>
      <PageHeader kicker="04" title="Account" />
      <div className="flex max-w-155 flex-col gap-10">
        <section>
          <SectionHeader>Appearance</SectionHeader>
          <fieldset className="mt-3">
            <legend className="sr-only">Theme</legend>
            <div className="flex flex-wrap gap-2">
              {THEMES.map((t) => (
                <label
                  key={t.value}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-sm border px-3.5 py-2 text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ac sm:min-h-0 ${
                    theme === t.value ? "border-ac bg-sf text-ink" : "border-ru text-mu"
                  }`}
                >
                  <input
                    type="radio"
                    name={groupId}
                    value={t.value}
                    checked={theme === t.value}
                    onChange={() => setTheme(t.value)}
                    className="sr-only"
                  />
                  <span className={theme === t.value ? "font-medium" : ""}>{t.label}</span>
                  <span className="text-[12px] text-mu">{t.note}</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-mu">Saved in this browser only.</p>
          </fieldset>
        </section>

        <section>
          <SectionHeader>Session</SectionHeader>
          <p className="mt-3 text-mu">Sign out of Syncro on this browser.</p>
          <div className="mt-4">
            {/* Cached data needs no clearing: sign-out leaves the page, which drops it. */}
            <button type="button" className="btn-secondary" onClick={() => auth.signOut()}>
              Sign out
            </button>
          </div>
        </section>

        <div className="lg:hidden">
          <LegalLinks />
        </div>
      </div>
    </Shell>
  );
}
