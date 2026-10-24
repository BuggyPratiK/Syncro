export class App {
  constructor(_opts?: any) {}
  getInstallationOctokit(_installationId: number) {
    return Promise.resolve({
      request: jest.fn().mockResolvedValue({
        data: {
          stats: { additions: 10, deletions: 2 },
          files: [{ filename: "src/index.ts" }],
        },
      }),
    });
  }
}