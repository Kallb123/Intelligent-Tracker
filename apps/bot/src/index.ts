import { DEFAULT_TIMEZONE } from '@tracker/core';

export const APP_NAME = 'bot';

export function startupMessage(): string {
  return `[${APP_NAME}] starting (timezone: ${DEFAULT_TIMEZONE})`;
}
