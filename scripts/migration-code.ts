import 'dotenv/config';
import { migrationToken } from '../server/auth.ts';
const username = process.argv[2];
const secret = process.env.ACCOUNT_MIGRATION_SECRET;
if (!username || !secret || secret.length < 32) {
  console.error('Usage: ACCOUNT_MIGRATION_SECRET=<same secret as server, at least 32 characters> npm run account:migration-code -- "Username"');
  process.exit(1);
}
console.log(migrationToken(username, secret, Date.now() + 24 * 60 * 60 * 1000));
