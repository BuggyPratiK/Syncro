/**
 * Telegram notification provider — Phase 2 stub.
 * Implement TelegramProvider when Phase 2 begins.
 */

import { NotificationProvider, NotificationPayload, NotificationResult } from "../../types/notification.types";

export class TelegramProvider implements NotificationProvider {
  readonly channel = "telegram" as const;

  async send(_payload: NotificationPayload): Promise<NotificationResult> {
    throw new Error("TelegramProvider is not implemented yet (Phase 2)");
  }
}
