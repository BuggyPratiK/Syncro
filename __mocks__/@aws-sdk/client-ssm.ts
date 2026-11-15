/**
 * Test stub for @aws-sdk/client-ssm. Tests must never reach real AWS: every
 * `send` rejects. Suites that need secrets inject a fake reader with
 * `setParameterReaderForTests` (src/config/secrets.ts) instead.
 */

export class GetParameterCommand {
  constructor(public readonly input: { Name: string; WithDecryption?: boolean }) {}
}

export class PutParameterCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

export class SSMClient {
  constructor(_config?: unknown) {}
  send(_command: unknown): Promise<never> {
    const error = new Error("Real SSM calls are blocked in tests; inject a fake reader.");
    error.name = "TestNetworkBlocked";
    return Promise.reject(error);
  }
  destroy(): void {}
}
