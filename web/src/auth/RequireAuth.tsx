import type { ReactNode } from "react";
import { PlainLayout } from "../components/Shell";
import { LoadingRows } from "../components/ui";
import { useAuth } from "./auth-context";

/**
 * Renders its children only for a signed-in user. Signed-out visitors see the
 * sign-in page instead; no API request is made for them.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.isLoading) {
    return (
      <PlainLayout>
        <LoadingRows rows={2} />
      </PlainLayout>
    );
  }
  if (!auth.isAuthenticated) return <SignInPage />;
  return <>{children}</>;
}

export function SignInPage() {
  const auth = useAuth();
  return (
    <PlainLayout>
      <section className="max-w-[620px]">
        <p className="label">Syncro</p>
        <h1 className="mt-1 font-serif text-[38px] leading-tight sm:text-[44px]">
          GitHub activity, relayed to Discord.
        </h1>
        <p className="mt-4 text-mu">
          Connect your GitHub repositories and Syncro posts pushes and pull requests to the Discord
          channels you choose.
        </p>
        <div className="mt-8">
          <button type="button" className="btn-primary" onClick={() => auth.signIn()}>
            Sign in
          </button>
        </div>
      </section>
    </PlainLayout>
  );
}
