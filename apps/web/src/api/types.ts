import type { paths } from './schema.js';

type JsonContent<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** The JSON request body of an operation, taken from the generated schema. */
export type RequestBody<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  requestBody: infer R;
}
  ? JsonContent<R>
  : never;

export type LoginInput = RequestBody<'/api/auth/login', 'post'>;
export type SetupInput = RequestBody<'/api/setup', 'post'>;
export type SetPasswordInput = RequestBody<'/api/invites/{token}/accept', 'post'>;
export type CreateInviteInput = RequestBody<'/api/invites', 'post'>;
export type ChangePasswordInput = RequestBody<'/api/auth/password', 'post'>;
