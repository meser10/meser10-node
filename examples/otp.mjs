/**
 * Sending a one-time password over SMS.
 *
 * Run: MESER10_API_KEY=... node examples/otp.mjs 0501234567
 *
 * Note what this example does NOT do: it does not generate the code, store it,
 * or check it. That belongs in your application, next to your session and your
 * rate limiting, not in a messaging client. What matters here is the sending.
 */

import { randomInt } from 'node:crypto';

import {
  ApiError,
  AuthenticationError,
  InvalidRequestError,
  Meser10Client,
  TransportError,
  smsParts,
} from '@meser10/api-client';

const key = process.env.MESER10_API_KEY;
const phone = process.argv[2];

if (!key) {
  console.error('Set MESER10_API_KEY first.');
  process.exit(1);
}
if (!phone) {
  console.error('Usage: node examples/otp.mjs <phone>');
  process.exit(1);
}

// Your application owns the code and its lifetime. This is only an example value.
const code = String(randomInt(100000, 1000000));

const client = new Meser10Client(key, { userAgent: 'my-app/1.0' });

const text = `קוד האימות שלך הוא ${code}. הקוד תקף ל-5 דקות.`;

// Hebrew goes out as Unicode, so a single part holds 70 characters, not 160.
console.log(`This message will be billed as ${smsParts(text)} part(s).`);

try {
  await client.sendSms(phone, text, 'MyShop');
  console.log('Accepted for delivery.');
} catch (error) {
  if (error instanceof InvalidRequestError) {
    // Refused before the network. Nothing sent, nothing spent.
    console.error(`Bad call: ${error.message}`);
    process.exit(2);
  }
  if (error instanceof AuthenticationError) {
    // Stop. Never loop here: repeated failures block this IP address for hours,
    // and the block is on the address, not the key.
    console.error(`Key rejected. Stopping: ${error.message}`);
    process.exit(3);
  }
  if (error instanceof ApiError) {
    // ErrorCode 4 on an SMS almost always means the sender identity is not
    // approved on the account yet.
    console.error(`Gateway refused it (ErrorCode ${error.errorCode}): ${error.message}`);
    process.exit(4);
  }
  if (error instanceof TransportError) {
    console.error(`Never got an answer: ${error.message}`);
    process.exit(5);
  }
  throw error;
}

/*
 * One honest caveat worth knowing before you build a login on this.
 *
 * "Accepted for delivery" is as much as the gateway will tell you. There is no
 * per-message delivery status and no webhook, so you cannot confirm that the
 * code reached the handset. Design the user's screen for that: offer a resend
 * after a short wait, and a second route in, rather than assuming delivery.
 */
