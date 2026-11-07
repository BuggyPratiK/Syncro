/**
 * Discord embed template for GitHub push events.
 *
 * Builds a rich Discord embed object. Discord-specific formatting
 * is ISOLATED here - webhook handlers never touch Discord payloads directly.
 *
 * Discord Embed API reference:
 * https://discord.com/developers/docs/resources/channel#embed-object
 */

import { NotificationPayload } from "../../types/notification.types";
import { formatDiff, truncateMessage } from "../../utils/format";

const MAX_COMMITS_SHOWN = 5;
const MAX_FILES_SHOWN = 6;
const DISCORD_COLOR_GREEN = 0x2ea043; // GitHub green - "branch updated"
const DISCORD_COLOR_RED = 0xf85149;   // GitHub red - "force push"

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer: { text: string };
  timestamp: string;
  url: string;
}

export function buildPushEmbed(payload: NotificationPayload): DiscordEmbed {
  const isForcePush = false; // Extend NotificationPayload if needed
  const color = isForcePush ? DISCORD_COLOR_RED : DISCORD_COLOR_GREEN;

  // Commit list
  const shownCommits = payload.commits.slice(0, MAX_COMMITS_SHOWN);
  const remainingCommits = payload.commits.length - shownCommits.length;

  const commitLines = shownCommits
    .map((c) => `\`${c.shortSha}\` ${truncateMessage(c.message)}`)
    .join("\n");

  const commitValue =
    commitLines + (remainingCommits > 0 ? `\n*...and ${remainingCommits} more*` : "");

  // Files changed
  const shownFiles = payload.changedFiles.slice(0, MAX_FILES_SHOWN);
  const remainingFiles = payload.changedFiles.length - shownFiles.length;

  const filesValue =
    shownFiles.map((f) => `\`${f}\``).join("\n") +
    (remainingFiles > 0 ? `\n*...and ${remainingFiles} more*` : "") ||
    "*No files changed*";

  // Pull command
  const pullCommand = `\`\`\`bash\ngit pull origin ${payload.branch}\n\`\`\``;

  return {
    title: `🚀 ${payload.branch.toUpperCase()} updated - ${payload.repoFullName}`,
    description:
      `**${payload.commits.length} commit${payload.commits.length !== 1 ? "s" : ""}** pushed by **${payload.pusherName}** ` +
      `• ${formatDiff(payload.totalAdditions, payload.totalDeletions)} • ${payload.totalFilesChanged} file${payload.totalFilesChanged !== 1 ? "s" : ""} changed`,
    color,
    fields: [
      {
        name: "📦 Commits",
        value: commitValue || "*No commits*",
        inline: false,
      },
      {
        name: "📁 Files Changed",
        value: filesValue,
        inline: false,
      },
      {
        name: "🔄 Sync your repo before starting work",
        value: pullCommand,
        inline: false,
      },
      {
        name: "🔗 Links",
        value: `[View Changes](${payload.compareUrl}) • [Repository](${payload.repoUrl})`,
        inline: false,
      },
    ],
    footer: { text: "Syncro • GitHub Notification Bot" },
    timestamp: payload.timestamp,
    url: payload.compareUrl,
  };
}
