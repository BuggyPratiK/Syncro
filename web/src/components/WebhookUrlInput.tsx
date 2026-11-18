/**
 * Write-only input for a Discord webhook URL (a bearer secret).
 *
 * - `type="password"`, never prefilled: the parent owns the value and must
 *   clear it after every submit, successful or not;
 * - the value is never rendered as text, put in a URL, logged or cached;
 * - the shape hint is advisory only; the server validates the URL.
 */

import { looksLikeDiscordWebhook, WEBHOOK_HINT, WEBHOOK_SHAPE_WARNING } from "../lib/discord-hint";
import { Field } from "./ui";

export function WebhookUrlInput({
  id,
  label = "Discord webhook URL",
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const showShapeWarning = value.length > 0 && !looksLikeDiscordWebhook(value);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={showShapeWarning ? WEBHOOK_SHAPE_WARNING : WEBHOOK_HINT}
      error={error}
    >
      <input
        id={id}
        type="password"
        className="input font-mono text-[12px]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        disabled={disabled}
        required
      />
    </Field>
  );
}
