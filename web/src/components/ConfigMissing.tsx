import { PlainLayout } from "./Shell";

/** Shown when the build is missing its public settings; lists names only. */
export function ConfigMissing({ missing }: { missing: string[] }) {
  return (
    <PlainLayout>
      <h1 className="font-serif text-[38px]">Syncro isn’t configured</h1>
      <p className="mt-2 text-mu">Missing or invalid build settings:</p>
      <ul className="mt-2 font-mono text-[12px]">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </PlainLayout>
  );
}
