/**
 * Every error this package throws extends Meser10Error, so one catch covers
 * the lot. Tell them apart when you need to act differently.
 */
export class Meser10Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Refused here, before the network. Nothing was sent and nothing was spent.
 * Fix the call.
 */
export class InvalidRequestError extends Meser10Error {}

/**
 * ErrorCode 1: the key was rejected.
 *
 * Catch this to stop, log and alert. Do not catch it to retry. Repeated
 * authentication failures block the calling IP address for several hours, and
 * the block is on the address rather than the key, so a retry loop takes down
 * every other integration sending from the same host. The client latches shut
 * after the first one for that reason.
 */
export class AuthenticationError extends Meser10Error {}

/** The call never produced a readable answer: network, timeout, or Cloudflare. */
export class TransportError extends Meser10Error {}

/**
 * The gateway answered with a failure that is not an authentication failure.
 *
 * `gatewayMessage` arrives in Hebrew on most failures, so show your own wording
 * to users and keep this one for the log.
 */
export class ApiError extends Meser10Error {
  /** Kept as a string because the gateway varies its type between functions. */
  readonly errorCode: string;
  readonly gatewayMessage: string;
  readonly fn: string;

  constructor(errorCode: string, gatewayMessage: string, fn: string, message: string) {
    super(message);
    this.errorCode = errorCode;
    this.gatewayMessage = gatewayMessage;
    this.fn = fn;
  }

  /** True when a single retry is reasonable. Never true for a key failure. */
  get isTransient(): boolean {
    return this.errorCode === '3';
  }

  static fromCode(code: string, gatewayMessage: string, fn: string): ApiError {
    let advice: string;

    switch (code) {
      case '3':
        advice =
          'An application error, either on the gateway or a payload it could not process at all. ' +
          'Safe to try once more; if it persists, send support the tracking id in the gateway message.';
        break;
      case '4':
        advice =
          'A parameter was missing or invalid. On createContact this most often means the named list ' +
          'does not exist on this account, and on an SMS it most often means the sender identity is ' +
          'not approved yet. The gateway message names which.';
        break;
      case '6':
        advice = 'The gateway does not know this function name.';
        break;
      default:
        advice = 'An error code this package does not recognise.';
    }

    return new ApiError(
      code,
      gatewayMessage,
      fn,
      `${fn} failed with ErrorCode ${code}. ${advice} Gateway said: ${gatewayMessage}`,
    );
  }
}
