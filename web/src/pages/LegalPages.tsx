/**
 * Privacy notice and terms. The wording is supplied by the project owner;
 * until it is, each required point is listed with a visible placeholder so
 * the pages cannot be mistaken for final legal text.
 */

import { PlainLayout } from "../components/Shell";

const PLACEHOLDER = "FOUNDER TEXT REQUIRED";

function Placeholder() {
  return <p className="mt-1 font-mono text-[12px] text-er">{PLACEHOLDER}</p>;
}

function LegalSection({ title }: { title: string }) {
  return (
    <section className="border-b border-ru py-4">
      <h2 className="font-serif text-[22px]">{title}</h2>
      <Placeholder />
    </section>
  );
}

export function PrivacyPage() {
  return (
    <PlainLayout>
      <article className="max-w-[620px]">
        <p className="label">Legal</p>
        <h1 className="font-serif text-[38px] leading-tight">Privacy notice</h1>
        <div className="mt-6 border-t border-ink">
          <LegalSection title="Sign-in and identity (Logto as identity processor)" />
          <LegalSection title="Where data is stored (Amazon Web Services)" />
          <LegalSection title="What your Discord channel sees (commit and pull request details, including from private repositories, are visible to everyone in the chosen channel)" />
          <LegalSection title="Deletion requests (contact)" />
        </div>
      </article>
    </PlainLayout>
  );
}

export function TermsPage() {
  return (
    <PlainLayout>
      <article className="max-w-[620px]">
        <p className="label">Legal</p>
        <h1 className="font-serif text-[38px] leading-tight">Terms of use</h1>
        <div className="mt-6 border-t border-ink">
          <LegalSection title="Terms" />
        </div>
      </article>
    </PlainLayout>
  );
}
