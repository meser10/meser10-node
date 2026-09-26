import { InvalidRequestError } from './errors.js';

/**
 * Checks a sender identity against the network rules before a request is spent
 * on it.
 *
 * Two forms are accepted. An alphanumeric sender name of up to 11 characters,
 * Latin letters, digits and spaces only, containing at least one letter. Or a
 * number, in local or E.164 form.
 *
 * The 11-character limit is a GSM constraint on alphanumeric sender IDs, not a
 * Meser 10 one, and support varies by destination: alphanumeric sender IDs are
 * not available in the United States or Canada, where a number is used instead.
 *
 * This checks the shape only. Whether the identity is approved on the account
 * is decided by the gateway.
 */
export function assertSenderIsWellFormed(from: string): void {
  const value = from.trim();

  if (value === '') {
    throw new InvalidRequestError('No sender identity given.');
  }

  if (/^\+?[0-9]{6,19}$/.test(value)) {
    return;
  }

  if (/[^A-Za-z0-9 ]/.test(value)) {
    throw new InvalidRequestError(
      `The sender name '${value}' contains characters the mobile networks reject. An alphanumeric ` +
        'sender name may hold only Latin letters, digits and spaces, so Hebrew text cannot be used ' +
        'as a sender name. Use an approved number instead.',
    );
  }

  if (value.length > 11) {
    throw new InvalidRequestError(
      `The sender name '${value}' is ${value.length} characters. The limit is 11, and a longer name ` +
        'is not truncated, the call is simply rejected.',
    );
  }

  if (!/[A-Za-z]/.test(value)) {
    throw new InvalidRequestError(
      `The sender name '${value}' has no letter in it. A digits-only value is rejected as an ` +
        'alphanumeric sender name. If you meant a phone number, give the full number.',
    );
  }
}

const GSM_7BIT =
  /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåÆæßÉ!"#¤%&'()*+,\-./:;<=>?_¡ÄÖÑÜ§¿äöñüà^{}[\]~|€]*$/;

/**
 * How many parts this text will be billed as.
 *
 * Any character outside the GSM 7-bit set, which includes every Hebrew letter,
 * pushes the whole message to Unicode: 70 characters for a single part, 67 per
 * part once it is concatenated.
 */
export function smsParts(text: string): number {
  const length = [...text].length;
  if (length === 0) return 0;

  const unicode = !GSM_7BIT.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;

  return length <= single ? 1 : Math.ceil(length / multi);
}
