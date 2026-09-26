# @meser10/api-client

Transactional SMS and email from Node, through the [Meser 10](https://www.meser10.co.il) JSON API. One-time passwords, order confirmations, receipts, delivery notices.

No dependencies. TypeScript types included. Node 18 and up, using the built-in `fetch`.

```bash
npm install @meser10/api-client
```

```ts
import { Meser10Client } from '@meser10/api-client';

const client = new Meser10Client(process.env.MESER10_API_KEY!, { userAgent: 'my-app/1.0' });

await client.sendSms('0501234567', 'Your code is 481902.', 'MyShop');
```

## What it covers

Five functions, which is what the JSON gateway exposes:

```ts
await client.sendSms(to, body, from);                         // one SMS, immediately
await client.sendEmail({ to, subject, html, from, replyTo }); // one email, immediately
await client.createContact(listName, fields);                 // add or update
await client.changeContactStatus(emailOrPhone, status);       // Active, Unsubscribed, Bounced
await client.status(email);                                    // read a contact's state
await client.verifyKey();                                      // is this key accepted?
```

Campaigns, mailing lists, groups, reporting and attachments are on the SOAP service, not on this gateway, so they are not here either.

## The three things this package exists to handle

Each one has cost somebody a working day.

**Every call answers HTTP 200, including a rejected key.** Success lives in `ErrorCode`, which the gateway serialises as a number on some functions and as a string on others. This client normalises it and throws on anything but zero, so a truthiness check cannot quietly be wrong.

**An authentication failure must never be retried.** Repeated failures block the *calling IP address* for several hours. The block is on the address rather than the key, so reissuing the key and trying again makes it worse, and on shared infrastructure it takes down every other integration sending from that machine. So this package has no retry logic anywhere, and after one `AuthenticationError` the client latches shut and refuses to reach the network again, even if your code loops:

```ts
for (let i = 0; i < 25; i++) {
  try { await client.sendSms(...); } catch { /* naive */ }
}
// Exactly one request left the process. There is a test for this.
```

When you suspect a key problem, call `verifyKey()` instead of retrying. It probes an address no account holds, so it creates nothing, sends nothing and spends nothing.

**The hosts sit behind Cloudflare with Browser Integrity Check on,** which reads the `User-Agent` header and blocks default library signatures. A User-Agent is always sent. If Cloudflare refuses anyway, you get a `TransportError` that says so rather than a JSON parse error, which usually means a proxy is rewriting the header.

## Things the gateway will not do, checked before a request is spent

`sendEmail()` refuses a comma separated recipient list, and an empty or malformed `replyTo`, locally. The gateway accepts no From address (a display name only), no CC, no BCC, no attachments and no second recipient, and the types give you no way to pass them. If a message needs them, this is not the transport for it.

`sendSms()` validates the sender identity first. An alphanumeric sender name is at most 11 characters, Latin letters, digits and spaces only, with at least one letter; or you give a number. A too-long name is not truncated by the network, the call is simply rejected, so catching it locally saves a wasted request:

```ts
import { assertSenderIsWellFormed } from '@meser10/api-client';

assertSenderIsWellFormed('Meser10 Ltd');    // fine, exactly 11
assertSenderIsWellFormed('Meser10 Israel'); // throws: 14 characters
assertSenderIsWellFormed('מסר 10');         // throws: Hebrew cannot be a sender name
assertSenderIsWellFormed('0501234567');     // fine, a number
```

The 11-character limit is a GSM constraint on alphanumeric sender IDs, not a Meser 10 one. Support varies by destination: alphanumeric sender IDs are not available in the United States or Canada, where a number is used instead.

`createContact()` refuses an unknown field name rather than dropping it silently, because `email` instead of `EMail` is the single easiest mistake to make here, and it fails in a way that looks like nothing happened. The `ContactFields` type catches it at compile time too.

## Hebrew

`smsParts()` tells you what a message will be billed as. One Hebrew letter anywhere pushes the whole message to Unicode, which takes a single part from 160 characters down to 70:

```ts
smsParts('a'.repeat(160));        // 1
smsParts('a'.repeat(100) + 'א');  // 2
```

For email, set `dir="rtl"` in your own HTML. Nothing does it for you, and Hebrew mail sent without it gets left aligned by some clients. That is the usual cause of "the email looks broken".

## Reading a contact's status

Two ids mean active. A contact created through the API is `10`; one moved back to Active after a bounce or an unsubscribe is `30`. Code that checks for `10` alone silently drops every reactivated contact, so use `isMailable`:

```ts
const status = await client.status('person@example.com');

status.exists;         // false when the address is not on the account
status.isMailable;     // true for 10 and for 30
status.isUnsubscribed; // 50
status.isBounced;      // 40
status.name;           // a stable English name for your logs
status.label;          // the gateway's own Hebrew text, for display only
```

`changeContactStatus()` answers success even for an address that is not on the account, so it cannot tell you whether the contact existed. `status()` is the only real check.

## Errors

Everything thrown extends `Meser10Error`, so one catch covers the lot. When you want to tell them apart:

| Error | Means | What to do |
|---|---|---|
| `InvalidRequestError` | Refused here, before the network. Nothing sent, nothing spent. | Fix the call. |
| `AuthenticationError` | `ErrorCode` 1, the key was rejected. | Stop. Alert. Never retry. |
| `ApiError` | Any other `ErrorCode`. Read `.errorCode`, `.gatewayMessage`, `.isTransient`. | `ErrorCode` 3 is worth one retry; 4 means a parameter, most often a list that does not exist or a sender not yet approved. |
| `TransportError` | No readable answer: network, timeout, or Cloudflare. | Log and move on. |

The gateway's own messages arrive in Hebrew on most failures, so show your own wording to users and keep `.gatewayMessage` for the log.

## Webhooks

There are no webhooks on this gateway. Anything that has to react to an event polls for it.

## Bringing your own fetch

Pass any function with the shape of `fetch`, to route calls through your own stack or to test without a network:

```ts
const client = new Meser10Client(key, {
  fetch: async (url, init) => myHttpClient(url, init),
  timeout: 10_000,
});
```

## Examples

- [`examples/otp.mjs`](examples/otp.mjs) sending a one-time password, and handling each failure separately
- [`examples/receipt.mjs`](examples/receipt.mjs) a Hebrew right-to-left transactional email
- [`examples/sync-contact.mjs`](examples/sync-contact.mjs) subscribing someone and reading the status back

## Tests

```bash
npm test
```

50 tests on `node:test`, and nothing touches the network or sends a message. They cover the `ErrorCode` contract in both serialisations, the latch that stops a retry loop, the sender name rules, Hebrew part counting, and the status ids.

## The machine-readable contract

The same five functions are published as an [OpenAPI 3.1 description](https://www.meser10.co.il/api-docs/meser10-json-api.json) and a [Postman collection](https://www.meser10.co.il/api-docs/meser10-json-api.postman_collection.json). There is a [PHP client](https://packagist.org/packages/meser10/api-client) built to the same design.

## Support

- Reference: <https://www.meser10.co.il/en/json-api>
- Hebrew documentation: <https://www.meser10.co.il/api-docs/>
- support@meser10.co.il, Sunday to Thursday

Never include your API key in a support message, a bug report or an issue. If one has been shared anywhere, reissue it in the Meser 10 interface.

## Licence

MIT. See [LICENSE](LICENSE).
