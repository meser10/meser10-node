/** What the gateway answers. ErrorCode is a number on some functions, a string on others. */
export interface GatewayResponse {
  ErrorCode?: number | string;
  Result?: string;
  MessageID?: number | string;
  Status?: string;
  StatusID?: number | string;
  [key: string]: unknown;
}

/** The thirteen fields createContact accepts. Note the capitalisation. */
export interface ContactFields {
  EMail?: string;
  PhoneNo?: string;
  FirstName?: string;
  LastName?: string;
  Address?: string;
  City?: string;
  Zipcode?: string;
  CustomField1?: string;
  CustomField2?: string;
  CustomField3?: string;
  CustomField4?: string;
  CustomField5?: string;
}

export type ContactStatusValue = 'Active' | 'Unsubscribed' | 'Bounced';

/**
 * The one seam in this package. Swap it in tests, or to route calls through
 * your own HTTP stack, without touching the contract handling.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Cloudflare reads this and blocks default library signatures. */
  userAgent?: string;
  baseUrl?: string;
  /** Milliseconds. Default 20000. */
  timeout?: number;
  fetch?: FetchLike;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** HTML. Set dir="rtl" yourself on Hebrew content. */
  html: string;
  /** A display name only. The address is the account's. */
  from: string;
  /** Required by the gateway, whatever older documentation shows. */
  replyTo: string;
}
