import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

export interface PasswordParams {
  /** Memory cost in KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/**
 * Argon2id at the OWASP password storage minimum (19 MiB, 2 passes, 1 lane). hash-wasm is used
 * because it is WebAssembly with the binary inlined: it bundles into the single `dist/main.js`
 * of the production image, which has no node_modules for native addons to live in.
 */
export const DEFAULT_PASSWORD_PARAMS: PasswordParams = {
  memoryKiB: 19_456,
  iterations: 2,
  parallelism: 1,
};

/** Hashes a password to a PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`). */
export function hashPassword(
  password: string,
  params: PasswordParams = DEFAULT_PASSWORD_PARAMS,
): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'encoded',
  });
}

/** Checks a password against a PHC string; a malformed hash simply does not match. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}
