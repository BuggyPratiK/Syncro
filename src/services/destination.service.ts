/**
 * Destination service — manages notification destination operations and DTO masking.
 */

import {
  createDiscordDestination,
  getDiscordDestination,
  listDiscordDestinations,
  updateDiscordDestination,
  deactivateDiscordDestination,
} from "../db/operations/destination.ops";
import {
  DiscordDestinationItem,
  SafeDiscordDestinationDto,
  CreateDestinationInput,
  UpdateDestinationInput,
  PaginationParams,
  PaginatedResult,
} from "../types/dynamodb.types";
import { maskWebhookUrl, logger } from "../utils/logger";

/**
 * Converts a raw DiscordDestinationItem into a safe DTO suitable for dashboard/API display.
 * Webhook tokens are never exposed in this DTO.
 */
export function toSafeDestinationDto(item: DiscordDestinationItem): SafeDiscordDestinationDto {
  return {
    destination_id: item.destination_id,
    provider: item.provider,
    display_name: item.display_name,
    is_active: item.is_active,
    created_at: item.created_at,
    updated_at: item.updated_at,
    webhook_url_masked: maskWebhookUrl(item.discord_webhook_url),
  };
}

/**
 * Creates a Discord destination and returns a safe DTO.
 */
export async function createDestinationService(
  input: CreateDestinationInput,
): Promise<SafeDiscordDestinationDto> {
  const item = await createDiscordDestination(input);
  logger.info("Created Discord destination", {
    destinationId: item.destination_id,
    displayName: item.display_name,
  });
  return toSafeDestinationDto(item);
}

/**
 * Retrieves a Discord destination by ID, returning a safe DTO or null.
 */
export async function getDestinationService(
  destinationId: string,
): Promise<SafeDiscordDestinationDto | null> {
  const item = await getDiscordDestination(destinationId);
  if (!item) return null;
  return toSafeDestinationDto(item);
}

/**
 * Lists Discord destinations, returning safe DTOs and pagination token.
 */
export async function listDestinationsService(
  params?: PaginationParams,
): Promise<PaginatedResult<SafeDiscordDestinationDto>> {
  const result = await listDiscordDestinations(params);
  return {
    items: result.items.map(toSafeDestinationDto),
    nextToken: result.nextToken,
  };
}

/**
 * Updates a Discord destination and returns an updated safe DTO.
 */
export async function updateDestinationService(
  destinationId: string,
  updates: UpdateDestinationInput,
): Promise<SafeDiscordDestinationDto> {
  const item = await updateDiscordDestination(destinationId, updates);
  logger.info("Updated Discord destination", {
    destinationId: item.destination_id,
    isActive: item.is_active,
  });
  return toSafeDestinationDto(item);
}

/**
 * Soft-deactivates a Discord destination and returns the updated safe DTO.
 */
export async function deactivateDestinationService(
  destinationId: string,
): Promise<SafeDiscordDestinationDto> {
  const item = await deactivateDiscordDestination(destinationId);
  logger.warn("Deactivated Discord destination", {
    destinationId: item.destination_id,
    displayName: item.display_name,
  });
  return toSafeDestinationDto(item);
}

