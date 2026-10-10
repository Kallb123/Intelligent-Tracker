import { DEFAULT_TIMEZONE } from '@tracker/core';

export { buildServer } from './server.js';

export const APP_NAME = 'api';

export function startupMessage(): string {
  return `[${APP_NAME}] starting (timezone: ${DEFAULT_TIMEZONE})`;
}
