import type { Database } from '@tracker/db';
import type { AuthConfig } from './config.js';
import type { FailureLimiter } from './auth/rate-limiter.js';

/** Everything the auth routes and guards share. Built once by `buildServer`. */
export interface ApiContext {
  db: Database;
  config: AuthConfig;
  limiters: {
    /** Failed logins per username/email. */
    identifier: FailureLimiter;
    /** Failed logins per client IP. */
    ip: FailureLimiter;
    /** Wrong "current password" attempts when changing a password, per member. */
    passwordChange: FailureLimiter;
  };
  /** Verifies against a throwaway hash, so unknown usernames take as long as known ones. */
  verifyDummy(password: string): Promise<void>;
}
