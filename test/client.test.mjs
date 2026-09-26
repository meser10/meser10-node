import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiError,
  AuthenticationError,
  ContactStatus,
  InvalidRequestError,
  Meser10Client,
  TransportError,
  assertSenderIsWellFormed,
  smsParts,
} from '../dist/index.js';

/**
 * Records what was sent and answers with whatever the test queued. Nothing here
 * touches the network, so the suite needs no credentials and sends no message.
 */
function fakeFetch() {
  const queue = [];
  const calls = [];

  const impl = async (url, init) => {
    calls.push({ url, init });

    if (queue.length === 0) {
      throw new Error('The fake fetch was called more times than the test queued.');
    }

    const next = queue.shift();

    return new Response(next.body, { status: next.status });
  };

  impl.calls = calls;
  impl.queue = (status, body) => {
    queue.push({ status, body });
    return impl;
  };
  impl.queueJson = (payload, status = 200) => impl.queue(status, JSON.stringify(payload));
  impl.last = () => calls[calls.length - 1];
  impl.lastBody = () => {
    const last = impl.last();
    return last?.init?.body ? JSON.parse(last.init.body) : null;
  };
  impl.lastUrl = () => impl.last()?.url ?? '';
  impl.lastHeaders = () => impl.last()?.init?.headers ?? {};

  return impl;
}

const client = (f) => new Meser10Client('test-key', { fetch: f });

/* --------------------------------------------------------- the ErrorCode contract */

test('a numeric ErrorCode 0 is success', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, Result: 'Call successful' });
  const out = await client(f).sendSms('0501234567', 'hello', 'MyShop');
  assert.equal(out.ErrorCode, 0);
});

test('a string ErrorCode "0" is also success', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: '0', Result: 'Call successful' });
  const out = await client(f).sendSms('0501234567', 'hello', 'MyShop');
  assert.equal(out.ErrorCode, '0');
});

test('HTTP 200 with ErrorCode 4 still throws', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 4, Result: 'sender not verified' }, 200);
  await assert.rejects(() => client(f).sendSms('0501234567', 'hi', 'MyShop'), ApiError);
});

test('a string ErrorCode "4" throws just the same', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: '4', Result: 'list missing' }, 200);
  await assert.rejects(() => client(f).createContact('Nope', { EMail: 'a@b.com' }), ApiError);
});

test('ErrorCode 3 is marked transient, 4 is not', () => {
  assert.equal(ApiError.fromCode('3', 'x', 'CreateContact').isTransient, true);
  assert.equal(ApiError.fromCode('4', 'x', 'CreateContact').isTransient, false);
});

/* ------------------------------------ authentication failure must not be retryable */

test('ErrorCode 1 throws AuthenticationError and says not to retry', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 1, Result: 'bad key' });
  await assert.rejects(() => client(f).sendSms('0501234567', 'hi', 'MyShop'), (error) => {
    assert.ok(error instanceof AuthenticationError);
    assert.match(error.message, /Do not retry/);
    return true;
  });
});

test('the client latches shut: a caller that loops never reaches the network twice', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 1, Result: 'bad key' });
  const c = client(f);

  for (let i = 0; i < 25; i++) {
    try {
      await c.sendSms('0501234567', 'hi', 'MyShop');
    } catch {
      // what a naive caller does
    }
  }

  assert.equal(f.calls.length, 1, 'exactly one request should have left the process');
});

test('verifyKey answers false on a rejected key instead of throwing', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 1, Result: 'bad key' });
  assert.equal(await client(f).verifyKey(), false);
});

test('verifyKey answers true on a valid key and writes nothing', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, Result: 'ok', StatusID: 0 });
  assert.equal(await client(f).verifyKey(), true);
  assert.equal(f.last().init.method, 'GET');
  assert.ok(f.lastUrl().includes('f=GetContactStatus'));
});

test('verifyKey does not swallow a transport failure', async () => {
  const f = fakeFetch().queue(502, 'Bad Gateway');
  await assert.rejects(() => client(f).verifyKey(), TransportError);
});

/* ------------------------------------------------------------------ request shape */

test('the key and a User-Agent are always sent', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).sendSms('0501234567', 'hi', 'MyShop');
  const headers = f.lastHeaders();
  assert.equal(headers.ApiKey, 'test-key');
  assert.match(headers['User-Agent'], /^meser10-node\//);
});

test('the key never travels on the query string', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).sendSms('0501234567', 'hi', 'MyShop');
  assert.equal(f.lastUrl().includes('test-key'), false);
});

test('the function name goes on the query string, the payload in the body', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).sendSms('0501234567', 'hello', 'MyShop');
  assert.ok(f.lastUrl().includes('f=SendSingleSmsMessage'));
  assert.deepEqual(f.lastBody(), {
    ToPhone: '0501234567',
    MessageBody: 'hello',
    FromName: 'MyShop',
  });
});

test('GetContactStatus puts the address on the query string, not in a body', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: 10, Status: 'פעיל' });
  await client(f).status('person@example.com');
  assert.equal(f.last().init.method, 'GET');
  assert.equal(f.last().init.body, undefined);
  assert.ok(f.lastUrl().includes('email=person%40example.com'));
});

test('Hebrew survives the round trip into the body', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).sendSms('0501234567', 'קוד האימות שלך', 'MyShop');
  assert.equal(f.lastBody().MessageBody, 'קוד האימות שלך');
});

/* ------------------------------------- email: the four things the gateway will not do */

test('replyTo is required', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () =>
      client(f).sendEmail({
        to: 'a@b.com',
        subject: 'S',
        html: '<p>x</p>',
        from: 'MyShop',
        replyTo: '',
      }),
    (error) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.message, /required/);
      return true;
    },
  );
  assert.equal(f.calls.length, 0, 'nothing should have been sent');
});

test('a malformed replyTo is caught before the request', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () =>
      client(f).sendEmail({
        to: 'a@b.com',
        subject: 'S',
        html: '<p>x</p>',
        from: 'Shop',
        replyTo: 'not-an-address',
      }),
    InvalidRequestError,
  );
  assert.equal(f.calls.length, 0);
});

test('a comma separated recipient list is refused', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () =>
      client(f).sendEmail({
        to: 'a@b.com,c@d.com',
        subject: 'S',
        html: '<p>x</p>',
        from: 'Shop',
        replyTo: 'r@e.com',
      }),
    (error) => {
      assert.match(error.message, /One recipient per call/);
      return true;
    },
  );
  assert.equal(f.calls.length, 0);
});

test('a valid email sends exactly the five accepted fields', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).sendEmail({
    to: 'a@b.com',
    subject: 'Your receipt',
    html: '<p>Thanks</p>',
    from: 'MyShop',
    replyTo: 'orders@shop.com',
  });
  assert.deepEqual(Object.keys(f.lastBody()), [
    'ToEMail',
    'Subject',
    'Body',
    'FromName',
    'ReplyToEMail',
  ]);
});

/* -------------------------------------------------------------- sender name rules */

for (const ok of ['MyShop', 'MESER10', 'Meser10 Ltd', 'A1', '0501234567', '+972501234567']) {
  test(`accepts '${ok}'`, () => {
    assertSenderIsWellFormed(ok);
  });
}

test('rejects a name longer than 11 characters', () => {
  assert.throws(() => assertSenderIsWellFormed('Meser10 Israel'), /14 characters/);
});

test('rejects Hebrew as a sender name', () => {
  assert.throws(() => assertSenderIsWellFormed('מסר 10'), /Hebrew/);
});

test('rejects a digits-only short value that is not a phone number', () => {
  assert.throws(() => assertSenderIsWellFormed('12345'), /no letter/);
});

test('rejects punctuation', () => {
  assert.throws(() => assertSenderIsWellFormed('My-Shop'), InvalidRequestError);
});

test('a bad sender name costs no request', async () => {
  const f = fakeFetch();
  await assert.rejects(() => client(f).sendSms('0501234567', 'hi', 'מסר 10'), InvalidRequestError);
  assert.equal(f.calls.length, 0);
});

/* ------------------------------------------------------------- SMS part counting */

test('160 Latin characters are one part, 161 are two', () => {
  assert.equal(smsParts('a'.repeat(160)), 1);
  assert.equal(smsParts('a'.repeat(161)), 2);
});

test('70 Hebrew characters are one part, 71 are two', () => {
  assert.equal(smsParts('א'.repeat(70)), 1);
  assert.equal(smsParts('א'.repeat(71)), 2);
});

test('one Hebrew letter makes the whole message Unicode', () => {
  assert.equal(smsParts('a'.repeat(100) + 'א'), 2);
});

test('an empty message is zero parts', () => {
  assert.equal(smsParts(''), 0);
});

/* ------------------------------------------------- contact status: two ids mean active */

test('StatusID 10 is mailable', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: 10, Status: 'פעיל' });
  const s = await client(f).status('a@b.com');
  assert.equal(s.isMailable, true);
  assert.equal(s.exists, true);
  assert.equal(s.name, 'active');
});

test('StatusID 30 is mailable too, which is the one people get wrong', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: 30, Status: 'פעיל' });
  const s = await client(f).status('a@b.com');
  assert.equal(s.isMailable, true);
  assert.equal(s.name, 'active_reactivated');
});

test('StatusID 0 means not on the account', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: 0 });
  const s = await client(f).status('a@b.com');
  assert.equal(s.exists, false);
  assert.equal(s.isMailable, false);
});

test('40 is bounced and 50 is unsubscribed, neither mailable', async () => {
  for (const [id, prop] of [
    [40, 'isBounced'],
    [50, 'isUnsubscribed'],
  ]) {
    const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: id });
    const s = await client(f).status('a@b.com');
    assert.equal(s[prop], true);
    assert.equal(s.isMailable, false);
  }
});

test('a string StatusID is coerced', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0, StatusID: '30' });
  assert.equal((await client(f).status('a@b.com')).isMailable, true);
});

test('an unknown id is named rather than guessed', () => {
  assert.equal(new ContactStatus(99).name, 'unknown_99');
  assert.equal(new ContactStatus(99).isMailable, false);
});

/* --------------------------------------------------------------------- contacts */

test('unknown contact fields are refused, with the right spelling offered', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () => client(f).createContact('Newsletter', { email: 'a@b.com' }),
    /capitalisation/,
  );
  assert.equal(f.calls.length, 0);
});

test('a contact needs an EMail or a PhoneNo', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () => client(f).createContact('Newsletter', { FirstName: 'Dana' }),
    InvalidRequestError,
  );
});

test('empty fields are omitted rather than sent as empty strings', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await client(f).createContact('Newsletter', { EMail: 'a@b.com', LastName: '  ' });
  assert.deepEqual(f.lastBody(), { ContactListName: 'Newsletter', EMail: 'a@b.com' });
});

test('changeContactStatus picks EMail or PhoneNo by what it was given', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 }).queueJson({ ErrorCode: 0 });
  const c = client(f);
  await c.changeContactStatus('a@b.com', 'Unsubscribed');
  assert.ok('EMail' in f.lastBody());
  await c.changeContactStatus('0501234567', 'Bounced');
  assert.ok('PhoneNo' in f.lastBody());
});

test('an unknown status value is refused locally', async () => {
  const f = fakeFetch();
  await assert.rejects(
    () => client(f).changeContactStatus('a@b.com', 'Removed'),
    InvalidRequestError,
  );
  assert.equal(f.calls.length, 0);
});

/* --------------------------------------------------- when the answer is not JSON */

test('a Cloudflare HTML page is reported as what it is', async () => {
  const f = fakeFetch().queue(403, '<html><body>Cloudflare Browser Integrity Check</body></html>');
  await assert.rejects(() => client(f).sendSms('0501234567', 'hi', 'MyShop'), /Cloudflare/);
});

test('any other non JSON body is reported with its status', async () => {
  const f = fakeFetch().queue(502, 'Bad Gateway');
  await assert.rejects(() => client(f).sendSms('0501234567', 'hi', 'MyShop'), /502/);
});

test('a thrown fetch becomes a TransportError', async () => {
  const boom = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(
    () => new Meser10Client('k', { fetch: boom }).sendSms('0501234567', 'hi', 'MyShop'),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.match(error.message, /ECONNRESET/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ construction */

test('an empty key is refused at construction', () => {
  assert.throws(() => new Meser10Client('   '), InvalidRequestError);
});

test('the User-Agent can be overridden', async () => {
  const f = fakeFetch().queueJson({ ErrorCode: 0 });
  await new Meser10Client('k', { fetch: f, userAgent: 'acme-crm/2.1' }).sendSms(
    '0501234567',
    'hi',
    'MyShop',
  );
  assert.equal(f.lastHeaders()['User-Agent'], 'acme-crm/2.1');
});
