/**
 * GitHub ownership verification with a fake transport (no network).
 *
 * Response shapes follow GitHub's REST API and the fields observed in the
 * Day 1 ownership checks: installation `target_type`, `app_id`,
 * `suspended_at`, `account.id`; repository `permissions.admin`; org
 * membership `state`, `role`, `organization.id`.
 */

import { createGitHubVerification } from "../../src/github/verification";
import { ContractError, type GitHubTransport, type GitHubTransportResponse } from "../../src/contracts";
import { ListingTooLargeError } from "../../src/db/operations/listing.ops";

const APP_ID = "777";
const USER_ID = 5001;
const TOKEN = { accessToken: "ghu_faketoken0123456789abcdefghijkl" };
const NOW = new Date("2026-11-15T12:00:00Z");

type Route = (url: URL, opts: { userToken?: string; form?: Record<string, string> }) => GitHubTransportResponse;

function ok(body: unknown, headers: Record<string, string> = {}): GitHubTransportResponse {
  return { status: 200, body, headers };
}
function status(code: number, headers: Record<string, string> = {}): GitHubTransportResponse {
  return { status: code, body: { message: "nope" }, headers };
}

function fakeTransport(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; opts: { userToken?: string; form?: Record<string, string> } }> = [];
  const transport: GitHubTransport = {
    async request(method, url, opts) {
      calls.push({ method, url, opts });
      const u = new URL(url);
      const route = routes[`${method} ${u.pathname}`];
      if (!route) throw new Error(`unexpected call ${method} ${u.pathname}`);
      return route(u, opts);
    },
  };
  return { transport, calls };
}

function installation(o: Partial<{ id: number; app_id: number; target_type: string; suspended_at: string | null; account: { id: number; login: string } }> = {}) {
  return { id: 42, app_id: Number(APP_ID), target_type: "User", suspended_at: null, account: { id: USER_ID, login: "alice" }, ...o };
}

const userRoute: Route = () => ok({ id: USER_ID, login: "alice" });
const installationsRoute = (list: unknown[]): Route => () => ok({ total_count: list.length, installations: list });

const lib = (orgInstallationsSupported = true) =>
  createGitHubVerification({ appId: APP_ID, clientId: "Iv1.client", clientSecret: "client-secret-value", orgInstallationsSupported, now: () => NOW });

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  return e instanceof ContractError ? e.code : `not a ContractError: ${String(e)}`;
}

describe("exchangeInstallCode", () => {
  it("exchanges the code server-side with the client credentials and returns the token in memory", async () => {
    const { transport, calls } = fakeTransport({ "POST /login/oauth/access_token": () => ok({ access_token: TOKEN.accessToken, token_type: "bearer" }) });
    await expect(lib().exchangeInstallCode(transport, { code: "abc123" })).resolves.toEqual(TOKEN);
    expect(calls[0].opts.form).toEqual({ client_id: "Iv1.client", client_secret: "client-secret-value", code: "abc123" });
  });

  it.each([
    ["a bad or reused code (200 with error)", () => ok({ error: "bad_verification_code" }), "github_code_invalid"],
    ["a non-2xx response", () => status(500), "github_unavailable"],
    ["a response without a token", () => ok({}), "github_unavailable"],
  ])("rejects %s", async (_label, route, code) => {
    const { transport } = fakeTransport({ "POST /login/oauth/access_token": route as Route });
    expect(await codeOf(lib().exchangeInstallCode(transport, { code: "abc123" }))).toBe(code);
  });

  it("rejects a malformed code without calling GitHub", async () => {
    const { transport, calls } = fakeTransport({});
    expect(await codeOf(lib().exchangeInstallCode(transport, { code: "a/b?c" }))).toBe("github_code_invalid");
    expect(calls).toHaveLength(0);
  });
});

describe("verifyUserInstallation: personal installations", () => {
  it("accepts the user's own personal installation and brands the result", async () => {
    const { transport } = fakeTransport({ "GET /user": userRoute, "GET /user/installations": installationsRoute([installation()]) });
    await expect(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" })).resolves.toEqual({
      installationId: "42",
      githubUserId: String(USER_ID),
      accountId: String(USER_ID),
      accountLogin: "alice",
      accountType: "User",
      proof: "personal_owner",
      verifiedVia: "user_oauth",
      verifiedAt: NOW.toISOString(),
    });
  });

  it("a personal installation listed for a collaborator (account.id ≠ user) is rejected", async () => {
    const { transport } = fakeTransport({
      "GET /user": userRoute,
      "GET /user/installations": installationsRoute([installation({ account: { id: 9999, login: "bob" } })]),
    });
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" }))).toBe("not_installation_owner");
  });

  it.each([
    ["a random installation ID", "123456"],
    ["another user's personal installation not visible to this user", "4343"],
  ])("rejects %s (the callback value is never proof)", async (_label, id) => {
    const { transport } = fakeTransport({ "GET /user": userRoute, "GET /user/installations": installationsRoute([installation()]) });
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: id }))).toBe("not_installation_owner");
  });

  it.each([
    ["an installation of another App", { app_id: 888 }],
    ["a suspended installation", { suspended_at: "2026-11-01T00:00:00Z" }],
    ["an unknown target type", { target_type: "Enterprise" }],
  ])("rejects %s", async (_label, override) => {
    const { transport } = fakeTransport({ "GET /user": userRoute, "GET /user/installations": installationsRoute([installation(override)]) });
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" }))).toBe("not_installation_owner");
  });

  it("finds an installation on a later page and checks total_count", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => installation({ id: 1000 + i }));
    const { transport, calls } = fakeTransport({
      "GET /user": userRoute,
      "GET /user/installations": (u) =>
        u.searchParams.get("page") === "1" ? ok({ total_count: 101, installations: page1 }) : ok({ total_count: 101, installations: [installation()] }),
    });
    await expect(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" })).resolves.toMatchObject({ proof: "personal_owner" });
    expect(calls.filter((c) => c.url.includes("/user/installations"))).toHaveLength(2);
  });

  it.each([
    ["fewer items than total_count", () => ok({ total_count: 5, installations: [installation()] })],
    ["an unexpected shape", () => ok({ items: [] })],
    ["a 401", () => status(401)],
    ["a rate-limit 403", () => status(403, { "x-ratelimit-remaining": "0" })],
    ["a 429", () => status(429)],
    ["a 5xx", () => status(502)],
  ])("fails closed on %s", async (_label, route) => {
    const { transport } = fakeTransport({ "GET /user": userRoute, "GET /user/installations": route as Route });
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" }))).toBe("github_unavailable");
  });

  it("fails closed when a later page repeats items (duplicates never count toward total_count)", async () => {
    const page = Array.from({ length: 100 }, (_, i) => installation({ id: 2000 + i }));
    const { transport } = fakeTransport({
      "GET /user": userRoute,
      "GET /user/installations": () => ok({ total_count: 200, installations: page }), // same page twice
    });
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "2000" }))).toBe("github_unavailable");
  });

  it("fails closed on a timeout", async () => {
    const transport: GitHubTransport = {
      async request() {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      },
    };
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" }))).toBe("github_unavailable");
  });
});

describe("verifyUserInstallation: organization installations", () => {
  const orgInst = installation({ id: 77, target_type: "Organization", account: { id: 6060, login: "acme-org" } });
  const membership = (body: unknown): Route => () => ok(body);
  const routes = (m: Route) => ({
    "GET /user": userRoute,
    "GET /user/installations": installationsRoute([orgInst]),
    "GET /user/memberships/orgs/acme-org": m,
  });

  it("accepts an active admin of exactly that organization", async () => {
    const { transport } = fakeTransport(routes(membership({ state: "active", role: "admin", organization: { id: 6060 } })));
    await expect(lib().verifyUserInstallation(transport, TOKEN, { installationId: "77" })).resolves.toMatchObject({
      accountType: "Organization",
      proof: "org_admin",
      accountId: "6060",
    });
  });

  it.each([
    ["member", { state: "active", role: "member", organization: { id: 6060 } }],
    ["billing_manager", { state: "active", role: "billing_manager", organization: { id: 6060 } }],
    ["pending admin", { state: "pending", role: "admin", organization: { id: 6060 } }],
    ["mismatched organization.id", { state: "active", role: "admin", organization: { id: 1 } }],
  ])("rejects %s", async (_label, body) => {
    const { transport } = fakeTransport(routes(membership(body)));
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "77" }))).toBe("not_installation_owner");
  });

  it.each([403, 404])("rejects (fails closed) on membership HTTP %i", async (code) => {
    const { transport } = fakeTransport(routes(() => status(code)));
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "77" }))).toBe("not_installation_owner");
  });

  it("an org installation the user does not administer is rejected", async () => {
    const { transport } = fakeTransport(routes(membership({ state: "active", role: "member", organization: { id: 6060 } })));
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "77" }))).toBe("not_installation_owner");
  });

  it("rejects any organization installation when organization support is off, without the membership call", async () => {
    const { transport, calls } = fakeTransport(routes(membership({ state: "active", role: "admin", organization: { id: 6060 } })));
    expect(await codeOf(lib(false).verifyUserInstallation(transport, TOKEN, { installationId: "77" }))).toBe("org_not_supported");
    expect(calls.some((c) => c.url.includes("/memberships/"))).toBe(false);
  });

  it("never uses repository admin rights as organization-admin proof", async () => {
    // Membership says member; a repo-level admin flag elsewhere must not matter.
    const { transport } = fakeTransport(routes(membership({ state: "active", role: "member", organization: { id: 6060 }, permissions: { admin: true } })));
    expect(await codeOf(lib().verifyUserInstallation(transport, TOKEN, { installationId: "77" }))).toBe("not_installation_owner");
  });
});

describe("listUserInstallationRepositories", () => {
  const repo = (id: number, admin: unknown) => ({ id, full_name: `alice/r${id}`, permissions: admin === undefined ? undefined : { admin } });
  const routes = (list: unknown[], total = list.length) => ({
    "GET /user": userRoute,
    "GET /user/installations/42/repositories": () => ok({ total_count: total, repositories: list }),
  });

  it("returns every repo with admin true only when GitHub says exactly true", async () => {
    const { transport } = fakeTransport(routes([repo(1, true), repo(2, false), repo(3, undefined), repo(4, "true")]));
    const listing = await lib().listUserInstallationRepositories(transport, TOKEN, { installationId: "42", githubUserId: String(USER_ID) });
    expect(listing).toMatchObject({ installationId: "42", githubUserId: String(USER_ID), verifiedAt: NOW.toISOString() });
    expect(listing.repos).toEqual([
      { repoId: "1", fullName: "alice/r1", admin: true },
      { repoId: "2", fullName: "alice/r2", admin: false },
      { repoId: "3", fullName: "alice/r3", admin: false },
      { repoId: "4", fullName: "alice/r4", admin: false },
    ]);
  });

  it("rejects a token that belongs to a different GitHub account", async () => {
    const { transport } = fakeTransport(routes([repo(1, true)]));
    expect(await codeOf(lib().listUserInstallationRepositories(transport, TOKEN, { installationId: "42", githubUserId: "1" }))).toBe(
      "not_installation_owner",
    );
  });

  it("fails closed when collected repos do not match total_count", async () => {
    const { transport } = fakeTransport(routes([repo(1, true)], 3));
    expect(await codeOf(lib().listUserInstallationRepositories(transport, TOKEN, { installationId: "42", githubUserId: String(USER_ID) }))).toBe(
      "github_unavailable",
    );
  });

  it("refuses a listing over 1,000 repos before paging through it", async () => {
    const { transport, calls } = fakeTransport(routes([repo(1, true)], 1001));
    const e = await lib()
      .listUserInstallationRepositories(transport, TOKEN, { installationId: "42", githubUserId: String(USER_ID) })
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ListingTooLargeError);
    expect(calls.filter((c) => c.url.includes("/repositories"))).toHaveLength(1);
  });
});

describe("token handling", () => {
  it("sends the token only as the user token and never puts it in errors or logs", async () => {
    const logs = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const { transport, calls } = fakeTransport({ "GET /user": userRoute, "GET /user/installations": installationsRoute([]) });

    const e = await lib().verifyUserInstallation(transport, TOKEN, { installationId: "42" }).catch((err: unknown) => err);

    expect(calls.every((c) => c.opts.userToken === TOKEN.accessToken && !c.url.includes(TOKEN.accessToken))).toBe(true);
    expect(String((e as Error).message)).not.toContain(TOKEN.accessToken);
    expect(logs.mock.calls.flat().join(" ")).not.toContain(TOKEN.accessToken);
    logs.mockRestore();
  });
});
