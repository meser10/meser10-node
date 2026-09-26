import { ContactStatus } from './contactStatus.js';
import {
  ApiError,
  AuthenticationError,
  InvalidRequestError,
  TransportError,
} from './errors.js';
import { assertSenderIsWellFormed } from './sms.js';
import type {
  ClientOptions,
  ContactFields,
  ContactStatusValue,
  EmailMessage,
  FetchLike,
  GatewayResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://heb.mesereser.com/Services/JsonServices.aspx';

/** An address no account has, for probing a key without writing anything. */
const PROBE_ADDRESS = 'nobody.probe@example.invalid';

export const VERSION = '1.0.0';

const CONTACT_FIELDS = [
  'EMail',
  'PhoneNo',
  'FirstName',
  'LastName',
  'Address',
  'City',
  'Zipcode',
  'CustomField1',
  'CustomField2',
  'CustomField3',
  'CustomField4',
  'CustomField5',
] as const;

const STATUS_VALUES: ContactStatusValue[] = ['Active', 'Unsubscribed', 'Bounced'];

/**
 * Client for the Meser 10 JSON gateway.
 *
 * Five functions: one SMS, one email, add or update a contact, change a
 * contact's status, read a contact's status. Campaigns, lists, groups,
 * reporting and attachments are on the SOAP service, not here.
 *
 * Three behaviours of the gateway are handled for you, because each one has
 * cost somebody a day:
 *
 *  - Every call answers HTTP 200, including a rejected key. Success lives in
 *    ErrorCode, which is a number on some functions and a string on others.
 *    This client normalises it and throws on anything but zero.
 *  - Repeated authentication failures block the calling IP address for several
 *    hours, and the block is on the address, not the key. So this client has no
 *    retry logic at all, and after one authentication failure it latches shut
 *    and refuses to call again, even if your code loops.
 *  - The hosts sit behind Cloudflare with Browser Integrity Check on, which
 *    reads the User-Agent header and blocks default library signatures. A
 *    User-Agent is always sent.
 */
export class Meser10Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeout: number;
  private readonly fetchImpl: FetchLike;

  /**
   * Set once an authentication failure has been seen, and never cleared. Build
   * a new client with a new key rather than retrying with this one.
   */
  private locked: AuthenticationError | null = null;

  /**
   * @param apiKey Issued per account in the Meser 10 interface, under account
   *               settings, advanced settings, API settings.
   */
  constructor(apiKey: string, options: ClientOptions = {}) {
    const key = (apiKey ?? '').trim();
    if (key === '') {
      throw new InvalidRequestError('The API key is empty.');
    }

    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new TransportError(
        'No fetch available. Use Node 18 or newer, or pass your own via the fetch option.',
      );
    }

    this.apiKey = key;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? `meser10-node/${VERSION}`;
    this.timeout = options.timeout ?? 20_000;
    this.fetchImpl = fetchImpl;
  }

  /* ----------------------------------------------------------------- messaging */

  /**
   * Sends one SMS to one recipient, immediately.
   *
   * MessageID comes back as 0, and the gateway has no way to read a message's
   * delivery state, so keep your own identifier if you need to trace a send.
   *
   * @param to   One recipient. Israeli local form or E.164.
   * @param body Hebrew is sent as Unicode, which shortens a single part from
   *             160 characters to 70. smsParts() counts.
   * @param from A sender identity already approved on the account. Validated
   *             here before the request is spent.
   */
  async sendSms(to: string, body: string, from: string): Promise<GatewayResponse> {
    const phone = (to ?? '').trim();
    const text = (body ?? '').trim();

    if (phone === '') {
      throw new InvalidRequestError('No recipient. One SMS goes to one number.');
    }
    if (text === '') {
      throw new InvalidRequestError('The message body is empty.');
    }

    assertSenderIsWellFormed(from);

    return this.post('SendSingleSmsMessage', {
      ToPhone: phone,
      MessageBody: text,
      FromName: from.trim(),
    });
  }

  /**
   * Sends one email to one recipient, immediately.
   *
   * The gateway accepts no From address (only a display name), no CC, no BCC,
   * no attachments and no second recipient. There is deliberately no way to
   * pass any of those: if a message needs them, this is not its transport.
   */
  async sendEmail(message: EmailMessage): Promise<GatewayResponse> {
    const entries: Array<[string, string]> = [
      ['recipient', message.to],
      ['subject', message.subject],
      ['body', message.html],
      ['sender name', message.from],
    ];

    for (const [what, value] of entries) {
      if ((value ?? '').trim() === '') {
        throw new InvalidRequestError(`The ${what} is empty.`);
      }
    }

    const replyTo = (message.replyTo ?? '').trim();
    if (replyTo === '') {
      throw new InvalidRequestError(
        'replyTo is required by the gateway. Without it the call fails with an application error.',
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
      throw new InvalidRequestError(`replyTo is not a valid address: ${replyTo}`);
    }
    if (message.to.includes(',') || message.to.includes(';')) {
      throw new InvalidRequestError(
        'One recipient per call. Send a separate message per address rather than a list.',
      );
    }

    return this.post('SendSingleEMailMessage', {
      ToEMail: message.to.trim(),
      Subject: message.subject,
      Body: message.html,
      FromName: message.from.trim(),
      ReplyToEMail: replyTo,
    });
  }

  /* ------------------------------------------------------------------ contacts */

  /**
   * Adds a contact to a named list, or updates them if they already exist.
   *
   * The list is not created for you. A name that does not exist on the same
   * account as the key fails, and the failure names the list.
   *
   * Unknown keys are refused rather than silently dropped, and empty values are
   * omitted rather than sent as empty strings.
   */
  async createContact(listName: string, fields: ContactFields): Promise<GatewayResponse> {
    const list = (listName ?? '').trim();
    if (list === '') {
      throw new InvalidRequestError('No list name. The gateway will not guess one.');
    }

    const payload: Record<string, string> = { ContactListName: list };

    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!(CONTACT_FIELDS as readonly string[]).includes(key)) {
        throw new InvalidRequestError(
          `Unknown contact field '${key}'. The gateway accepts: ${CONTACT_FIELDS.join(', ')}. ` +
            'Note the capitalisation of EMail and PhoneNo.',
        );
      }
      const trimmed = String(value ?? '').trim();
      if (trimmed !== '') {
        payload[key] = trimmed;
      }
    }

    if (payload.EMail === undefined && payload.PhoneNo === undefined) {
      throw new InvalidRequestError('A contact needs at least an EMail or a PhoneNo.');
    }

    return this.post('CreateContact', payload);
  }

  /**
   * Moves a contact to Active, Unsubscribed or Bounced.
   *
   * An address which is not on the account also answers success, so this cannot
   * tell you whether the contact existed. Use status() for that.
   */
  async changeContactStatus(
    emailOrPhone: string,
    status: ContactStatusValue,
  ): Promise<GatewayResponse> {
    const who = (emailOrPhone ?? '').trim();
    if (who === '') {
      throw new InvalidRequestError('No contact given.');
    }
    if (!STATUS_VALUES.includes(status)) {
      throw new InvalidRequestError(
        `Status must be one of ${STATUS_VALUES.join(', ')}, got '${status}'.`,
      );
    }

    const key = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who) ? 'EMail' : 'PhoneNo';

    return this.post('ChangeContactStatus', { [key]: who, Status: status });
  }

  /**
   * Reads a contact's current status.
   *
   * Only an email address works here: the gateway does not read a phone
   * parameter, and the address has to travel on the query string, which this
   * method does for you.
   */
  async status(email: string): Promise<ContactStatus> {
    const address = (email ?? '').trim();
    if (address === '') {
      throw new InvalidRequestError('No address given.');
    }

    const body = await this.get('GetContactStatus', { email: address });

    return ContactStatus.fromResponse(body);
  }

  /**
   * Is this key accepted? Creates nothing, sends nothing, spends nothing.
   *
   * Use this instead of retrying a real call when you suspect a key problem.
   * Retrying is what gets an IP address blocked.
   */
  async verifyKey(): Promise<boolean> {
    try {
      await this.get('GetContactStatus', { email: PROBE_ADDRESS });

      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return false;
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ plumbing */

  private post(fn: string, payload: Record<string, unknown>): Promise<GatewayResponse> {
    return this.call('POST', fn, {}, JSON.stringify(payload));
  }

  private get(fn: string, query: Record<string, string>): Promise<GatewayResponse> {
    return this.call('GET', fn, query, null);
  }

  private async call(
    method: 'GET' | 'POST',
    fn: string,
    query: Record<string, string>,
    body: string | null,
  ): Promise<GatewayResponse> {
    if (this.locked) {
      // Deliberate: a caller that loops on failure must not reach the network
      // again, because that is what blocks the IP address.
      throw this.locked;
    }

    const url = `${this.baseUrl}?${new URLSearchParams({ f: fn, ...query }).toString()}`;

    const headers: Record<string, string> = {
      ApiKey: this.apiKey,
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
        // No automatic retries anywhere in this package. See the locked flag.
        redirect: 'manual',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TransportError(
        controller.signal.aborted
          ? `The request did not complete within ${this.timeout}ms.`
          : `The request did not complete: ${reason}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    let decoded: GatewayResponse;
    try {
      decoded = JSON.parse(raw) as GatewayResponse;
    } catch {
      if (response.status === 403 || /cloudflare/i.test(raw)) {
        throw new TransportError(
          'Cloudflare refused the request, which happens when the User-Agent is a default library ' +
            'signature. This client sets one, so check whether a proxy is replacing it. HTTP status ' +
            `was ${response.status}.`,
        );
      }
      throw new TransportError(
        `The gateway answered something that is not JSON (HTTP ${response.status}): ` +
          raw.trim().slice(0, 200),
      );
    }

    // ErrorCode is a number on some functions and a string on others.
    const code = decoded.ErrorCode === undefined ? '' : String(decoded.ErrorCode);
    const result = decoded.Result === undefined ? '' : String(decoded.Result);

    if (code === '0') {
      return decoded;
    }

    if (code === '1') {
      this.locked = new AuthenticationError(
        'The API key was rejected. Do not retry: repeated authentication failures block the calling ' +
          'IP address for several hours, and the block is on the address, not the key, so reissuing ' +
          `the key and trying again makes it worse. Gateway said: ${result}`,
      );

      throw this.locked;
    }

    throw ApiError.fromCode(code, result, fn);
  }
}
