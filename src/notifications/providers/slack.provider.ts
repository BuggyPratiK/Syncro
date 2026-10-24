/**
 * Slack notification provider — Phase 3 stub.
 * Implement SlackProvider when Phase 3 begins.
 */

import { NotificationProvider, NotificationPayload, NotificationResult } from "../../types/notification.types";

export class SlackProvider implements NotificationProvider {
  readonly channel = "slack" as const;

  async send(_payload: NotificationPayload): Promise<NotificationResult> {
    throw new Error("SlackProvider is not implemented yet (Phase 3)");
  }
}
