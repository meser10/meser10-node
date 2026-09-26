/**
 * Sending one transactional email, in Hebrew, right to left.
 *
 * Run: MESER10_API_KEY=... node examples/receipt.mjs you@example.com
 */

import { Meser10Client, Meser10Error } from '@meser10/api-client';

const key = process.env.MESER10_API_KEY;
const to = process.argv[2];

if (!key || !to) {
  console.error('Usage: MESER10_API_KEY=... node examples/receipt.mjs <email>');
  process.exit(1);
}

// Nothing sets the direction for you. Hebrew mail sent without dir="rtl" gets
// left aligned by some clients, which is the usual cause of "the email looks
// broken" reports.
const html = `<!doctype html>
<html dir="rtl" lang="he">
<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    <h1 style="font-size:20px;margin:0 0 12px;">תודה על הרכישה</h1>
    <p style="font-size:15px;line-height:1.7;color:#3a3f52;margin:0 0 8px;">
      ההזמנה נרשמה והחשבונית מצורפת לחשבון שלך.
    </p>
    <p style="font-size:13px;color:#5a6070;margin:16px 0 0;">מספר הזמנה: 10482</p>
  </div>
</body>
</html>`;

try {
  const client = new Meser10Client(key, { userAgent: 'my-app/1.0' });

  await client.sendEmail({
    to,
    subject: 'החשבונית שלך',
    html,
    from: 'MyShop', // a display name only, the address is the account's
    replyTo: 'orders@example.com', // required, whatever older docs show
  });

  console.log('Accepted for delivery.');
} catch (error) {
  if (error instanceof Meser10Error) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

/*
 * Four things this function will not do, so check before routing a message
 * through it: no From address (a display name only), no CC or BCC, no
 * attachments, and no second recipient. The client refuses a comma separated
 * list rather than letting the gateway silently take the first address.
 */
