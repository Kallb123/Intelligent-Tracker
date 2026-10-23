// Prints a new VAPID key pair as .env lines: pnpm --filter @tracker/worker vapid:generate
// Generate it once and keep it: browsers subscribe against the public key, so changing the pair
// later invalidates every existing push subscription.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
