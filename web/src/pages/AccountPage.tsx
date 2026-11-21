import { useAuth } from "../auth/auth-context";
import { LegalLinks, Shell } from "../components/Shell";
import { PageHeader } from "../components/ui";

export function AccountPage() {
  const auth = useAuth();
  return (
    <Shell>
      <PageHeader kicker="04" title="Account" />
      <section className="max-w-[620px] border-t border-ink pt-4">
        <p className="text-mu">Sign out of Syncro on this browser.</p>
        <div className="mt-4">
          {/* Cached data needs no clearing: sign-out leaves the page, which drops it. */}
          <button type="button" className="btn-secondary" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
        <div className="mt-10 lg:hidden">
          <LegalLinks />
        </div>
      </section>
    </Shell>
  );
}
