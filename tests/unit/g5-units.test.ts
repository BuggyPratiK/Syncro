/**
 * Response mappers (no internal fields leak), delivery stamping request
 * shape, and the GitHub HTTP transport's safety rules.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { markDeliveryIgnored, markDeliveryProcessed } from "../../src/db/operations/delivery.ops";
import { toDestinationDto, toInstallationDto, toRepoDto, toRepoListingDto } from "../../src/services/tenant-dto";
import { createFetchGitHubTransport } from "../../src/github/transport";

jest.mock("../../src/db/client", () => ({ ddb: { send: jest.fn() } }));

const WS = "ws_11111111-1111-4111-8111-111111111111";

describe("response mappers", () => {
  it("destination DTO masks the URL from the webhook ID and exposes no secret reference or workspace", () => {
    const record = {
      destinationId: "d1",
      workspaceId: WS,
      provider: "discord" as const,
      displayName: "Alerts",
      status: "active" as const,
      webhookId: "123456789012345678",
      createdAt: "c",
      updatedAt: "u",
      // Extra internal fields must not pass through even if present at runtime.
      secret_ref: { name: "/syncro/prod/ws/x/dest/y/discord-webhook-url", version: 2 },
    };
    const dto = toDestinationDto(record);
    expect(dto).toEqual({
      destinationId: "d1",
      provider: "discord",
      displayName: "Alerts",
      status: "active",
      webhookUrlMasked: "discord.com/api/webhooks/123456789012345678/••••",
      createdAt: "c",
      updatedAt: "u",
    });
    expect(JSON.stringify(dto)).not.toMatch(/syncro\/prod|secret|workspace/i);
  });

  it("repo, installation and listing DTOs carry only their contract fields", () => {
    expect(
      toRepoDto({ repoId: "1", fullName: "a/b", installationId: "9", workspaceId: WS, watchedBranch: "main", isActive: true, createdAt: "c", updatedAt: "u" }),
    ).toEqual({ repoId: "1", fullName: "a/b", installationId: "9", watchedBranch: "main", isActive: true, createdAt: "c", updatedAt: "u" });
    expect(
      toInstallationDto({ installationId: "9", workspaceId: WS, accountId: "5", accountLogin: "o", accountType: "User", claimedByGithubUserId: "5", status: "active", verifiedAt: "v", createdAt: "c" }),
    ).toEqual({ installationId: "9", accountLogin: "o", accountType: "User", status: "active", claimedAt: "c" });
    expect(
      toRepoListingDto({ listingId: "l", installationId: "9", githubUserId: "5", repos: [{ repoId: "1", fullName: "a/b", admin: true }], verifiedAt: "v", expiresAt: "e" }),
    ).toEqual({ listingId: "l", installationId: "9", expiresAt: "e", repos: [{ repoId: "1", fullName: "a/b", admin: true }] });
  });
});

describe("delivery stamping request", () => {
  beforeEach(() => (ddb.send as jest.Mock).mockReset().mockResolvedValue({}));

  it("stamps workspace, ledger key, created_at from received_at and the summary, conditioned on workspace consistency", async () => {
    const summary = { repo_full_name: "a/b", event_type: "push" };
    await markDeliveryProcessed("d1", { workspaceId: WS, summary });
    const cmd = (ddb.send as jest.Mock).mock.calls[0][0] as UpdateCommand;
    expect(cmd.input.UpdateExpression).toContain("created_at = if_not_exists(created_at, received_at)");
    expect(cmd.input.ConditionExpression).toBe("attribute_exists(PK) AND (attribute_not_exists(workspace_id) OR workspace_id = :ws)");
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ":ws": WS, ":gsi": `WS#${WS}#DELIVERY`, ":summary": summary, ":status": "processed" });
  });

  it("an ignored delivery is never stamped", async () => {
    await markDeliveryIgnored("d1", "repo_not_tenant");
    const cmd = (ddb.send as jest.Mock).mock.calls[0][0] as UpdateCommand;
    expect(cmd.input.UpdateExpression).not.toMatch(/workspace_id|GSI1PK|summary/);
  });
});

describe("GitHub HTTP transport", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each(["http://api.github.com/user", "https://evil.example/user", "https://api.github.com.evil.example/user"])(
    "refuses a non-GitHub or non-HTTPS URL: %s",
    async (url) => {
      global.fetch = jest.fn();
      await expect(createFetchGitHubTransport().request("GET", url, {})).rejects.toThrow("host not allowed");
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("sends the token as a bearer header, refuses redirects and sets a timeout", async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "X-RateLimit-Remaining": "10" } })) as unknown as typeof fetch;
    const res = await createFetchGitHubTransport(3000).request("GET", "https://api.github.com/user", { userToken: "ghu_x" });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer ghu_x");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(res).toEqual({ status: 200, body: { id: 1 }, headers: expect.objectContaining({ "x-ratelimit-remaining": "10" }) });
  });

  it("form-encodes the OAuth code exchange and asks for JSON", async () => {
    global.fetch = jest.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await createFetchGitHubTransport().request("POST", "https://github.com/login/oauth/access_token", { form: { code: "c", client_id: "i" } });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.body).toBe("code=c&client_id=i");
  });
});
