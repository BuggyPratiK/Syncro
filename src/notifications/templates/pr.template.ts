/**
 * Discord embed template for GitHub Pull Request events.
 *
 * Builds a rich Discord embed object isolated from webhook handler logic.
 *
 * Discord Embed API reference:
 * https://discord.com/developers/docs/resources/channel#embed-object
 */

import { NotificationPayload } from "../../types/notification.types";
import { formatDiff, truncateMessage } from "../../utils/format";

const DISCORD_COLOR_GREEN = 0x2ea043;
const DISCORD_COLOR_PURPLE = 0x8250df;
const DISCORD_COLOR_RED = 0xf85149;
const DISCORD_COLOR_GRAY = 0x6e7681;

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer: { text: string };
  timestamp: string;
  url: string;
}

export function buildPrEmbed(payload: NotificationPayload): DiscordEmbed {
  const pr = payload.pullRequest;

  if (!pr) {
    return {
      title: `🔀 Pull Request - ${payload.repoFullName}`,
      description: `Pull request activity in **${payload.repoFullName}**`,
      color: DISCORD_COLOR_GREEN,
      fields: [],
      footer: { text: "Syncro • GitHub Notification Bot" },
      timestamp: payload.timestamp,
      url: payload.repoUrl,
    };
  }

  const isMerged = pr.merged === true;
  const isDraft = pr.draft === true;

  let color = DISCORD_COLOR_GREEN;
  let actionTitle = "opened";
  let icon = "🔀";

  if (isMerged) {
    color = DISCORD_COLOR_PURPLE;
    actionTitle = `merged into ${pr.baseBranch}`;
    icon = "🟣";
  } else if (pr.action === "closed") {
    color = DISCORD_COLOR_RED;
    actionTitle = "closed without merging";
    icon = "🔴";
  } else if (pr.action === "reopened") {
    color = DISCORD_COLOR_GREEN;
    actionTitle = "reopened";
    icon = "🔄";
  } else if (isDraft) {
    color = DISCORD_COLOR_GRAY;
    actionTitle = "opened as draft";
    icon = "📝";
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: "🎯 Branches",
      value: `\`${pr.headBranch}\` ➔ \`${pr.baseBranch}\``,
      inline: true,
    },
    {
      name: "📊 Changes",
      value: `${formatDiff(payload.totalAdditions, payload.totalDeletions)} • ${payload.totalFilesChanged} file${payload.totalFilesChanged !== 1 ? "s" : ""} changed`,
      inline: true,
    },
  ];

  if (pr.body) {
    fields.push({
      name: "📝 Description",
      value: truncateMessage(pr.body, 200),
      inline: false,
    });
  }

  // Contributor action guidance
  if (isMerged) {
    fields.push({
      name: "🔄 Sync your local branch with main",
      value: `\`\`\`bash\ngit pull origin ${pr.baseBranch}\n\`\`\``,
      inline: false,
    });
  } else if (pr.action === "opened" || pr.action === "reopened") {
    fields.push({
      name: "👀 Review Required",
      value: `Review the proposed changes before merging into \`${pr.baseBranch}\`.`,
      inline: false,
    });
  }

  fields.push({
    name: "🔗 Links",
    value: `[View Pull Request](${pr.url}) • [Repository](${payload.repoUrl})`,
    inline: false,
  });

  return {
    title: `${icon} PR #${pr.number} ${actionTitle} - ${payload.repoFullName}`,
    description: `**${pr.title}**\nOpened by **${pr.authorName}**`,
    color,
    fields,
    footer: { text: "Syncro • GitHub Notification Bot" },
    timestamp: payload.timestamp,
    url: pr.url,
  };
}
