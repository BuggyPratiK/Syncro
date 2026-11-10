import { migrateDestinations } from "../../scripts/migrate-destinations";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

describe("migrateDestinations", () => {
  const WEBHOOK_A = "https://discord.com/api/webhooks/111111111111111111/token-alpha";
  const WEBHOOK_B = "https://discord.com/api/webhooks/222222222222222222/token-beta";

  let mockDdb: any;

  beforeEach(() => {
    mockDdb = {
      send: jest.fn(),
    };
  });

  it("dry-run mode does not issue PutCommand or UpdateCommand", async () => {
    // 1. Existing destinations: none
    mockDdb.send.mockResolvedValueOnce({ Items: [] });
    // 2. Repositories: 2 repos sharing WEBHOOK_A
    mockDdb.send.mockResolvedValueOnce({
      Items: [
        {
          PK: "REPO#1",
          SK: "CONFIG",
          github_repo_id: "1",
          github_full_name: "org/repo-1",
          discord_webhook_url: WEBHOOK_A,
          watched_branch: "main",
          is_active: true,
        },
        {
          PK: "REPO#2",
          SK: "CONFIG",
          github_repo_id: "2",
          github_full_name: "org/repo-2",
          discord_webhook_url: WEBHOOK_A,
          watched_branch: "staging",
          is_active: true,
        },
      ],
    });

    const summary = await migrateDestinations({
      dryRun: true,
      documentClient: mockDdb,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.totalReposScanned).toBe(2);
    expect(summary.newDestinationsCreated).toBe(1);
    expect(summary.reusedDestinationsCount).toBe(1);
    expect(summary.reposUpdated).toBe(2);

    // Verify no PutCommand or UpdateCommand were executed in dry-run mode
    const putCalls = mockDdb.send.mock.calls.filter((c: any) => c[0] instanceof PutCommand);
    const updateCalls = mockDdb.send.mock.calls.filter((c: any) => c[0] instanceof UpdateCommand);
    expect(putCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);

    // Verify secret masking in output plan
    expect(summary.plan[0].maskedUrl).toContain("[REDACTED]");
    expect(summary.plan[0].maskedUrl).not.toContain("token-alpha");
  });

  it("live mode creates destination and links repositories sharing same URL", async () => {
    // 1. Existing destinations: none
    mockDdb.send.mockResolvedValueOnce({ Items: [] });
    // 2. Repositories: 2 repos sharing WEBHOOK_A, 1 repo with WEBHOOK_B
    mockDdb.send.mockResolvedValueOnce({
      Items: [
        {
          PK: "REPO#1",
          SK: "CONFIG",
          github_repo_id: "1",
          github_full_name: "org/repo-1",
          discord_webhook_url: WEBHOOK_A,
          watched_branch: "main",
          is_active: true,
        },
        {
          PK: "REPO#2",
          SK: "CONFIG",
          github_repo_id: "2",
          github_full_name: "org/repo-2",
          discord_webhook_url: WEBHOOK_A,
          watched_branch: "main",
          is_active: true,
        },
        {
          PK: "REPO#3",
          SK: "CONFIG",
          github_repo_id: "3",
          github_full_name: "org/repo-3",
          discord_webhook_url: WEBHOOK_B,
          watched_branch: "dev",
          is_active: false,
        },
      ],
    });
    // Put / Update mock responses
    mockDdb.send.mockResolvedValue({});

    const summary = await migrateDestinations({
      dryRun: false,
      documentClient: mockDdb,
    });

    expect(summary.totalReposScanned).toBe(3);
    expect(summary.newDestinationsCreated).toBe(2); // WEBHOOK_A and WEBHOOK_B
    expect(summary.reusedDestinationsCount).toBe(1); // 2nd repo reuses WEBHOOK_A
    expect(summary.reposUpdated).toBe(3);

    // Check that exactly 2 destinations were written
    const putCalls = mockDdb.send.mock.calls.filter((c: any) => c[0] instanceof PutCommand);
    expect(putCalls).toHaveLength(2);

    // Check that all 3 repos were updated with destination ID
    const updateCalls = mockDdb.send.mock.calls.filter((c: any) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(3);
  });

  it("is idempotent: skips repos that already have valid destination references", async () => {
    const existingDest = {
      PK: "DESTINATION#dest-existing",
      SK: "CONFIG",
      destination_id: "dest-existing",
      display_name: "Pre-existing",
      discord_webhook_url: WEBHOOK_A,
      is_active: true,
    };

    // 1. Existing destinations: dest-existing
    mockDdb.send.mockResolvedValueOnce({ Items: [existingDest] });
    // 2. Repositories: 1 already migrated, 1 not migrated
    mockDdb.send.mockResolvedValueOnce({
      Items: [
        {
          PK: "REPO#1",
          SK: "CONFIG",
          github_repo_id: "1",
          github_full_name: "org/repo-1",
          discord_destination_id: "dest-existing",
          watched_branch: "main",
          is_active: true,
        },
        {
          PK: "REPO#2",
          SK: "CONFIG",
          github_repo_id: "2",
          github_full_name: "org/repo-2",
          discord_webhook_url: WEBHOOK_A, // Shares same URL as existingDest!
          watched_branch: "main",
          is_active: true,
        },
      ],
    });
    mockDdb.send.mockResolvedValue({});

    const summary = await migrateDestinations({
      dryRun: false,
      documentClient: mockDdb,
    });

    expect(summary.alreadyMigratedCount).toBe(1);
    expect(summary.newDestinationsCreated).toBe(0); // Reused existingDest!
    expect(summary.reusedDestinationsCount).toBe(1);
    expect(summary.reposUpdated).toBe(1);
  });
});
