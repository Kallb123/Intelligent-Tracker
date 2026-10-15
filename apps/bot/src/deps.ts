import type { Database } from '@tracker/db';
import type { Logger } from './logger.js';

/** What the handlers need besides the update they are handling. */
export interface BotDeps {
  db: Database;
  /** The clock; tests pin it. */
  now: () => Date;
  logger: Logger;
  /** The web app's address, for replies that send people there. */
  publicBaseUrl: string | undefined;
}
