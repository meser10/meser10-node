/**
 * Subscribing someone, and reading their status back.
 *
 * Run: MESER10_API_KEY=... node examples/sync-contact.mjs you@example.com Newsletter
 */

import { ApiError, Meser10Client, Meser10Error } from '@meser10/api-client';

const key = process.env.MESER10_API_KEY;
const email = process.argv[2];
const list = process.argv[3] ?? 'Newsletter';

if (!key || !email) {
  console.error('Usage: MESER10_API_KEY=... node examples/sync-contact.mjs <email> [list]');
  process.exit(1);
}

const client = new Meser10Client(key, { userAgent: 'my-app/1.0' });

try {
  // Check before writing. A successful changeContactStatus proves nothing about
  // whether the contact existed, so this read is the only real check.
  const before = await client.status(email);
  console.log(`Before: ${before.name}`);

  if (before.isUnsubscribed) {
    // Someone who removed themselves should not be quietly re-added.
    console.log('They unsubscribed. Not re-adding them.');
    process.exit(0);
  }

  await client.createContact(list, {
    EMail: email,
    FirstName: 'Dana',
    LastName: 'Levi',
    City: 'Tel Aviv',
  });

  const after = await client.status(email);
  console.log(`After: ${after.name}, mailable: ${after.isMailable ? 'yes' : 'no'}`);
} catch (error) {
  if (error instanceof ApiError && error.errorCode === '4') {
    // The most common cause by far: the list name does not exist on this
    // account. The gateway names it in the message.
    console.error(`The gateway refused a parameter. Usually the list: ${error.gatewayMessage}`);
    process.exit(4);
  }
  if (error instanceof Meser10Error) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
