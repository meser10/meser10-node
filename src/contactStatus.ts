/**
 * A contact's state on the account.
 *
 * The gateway returns both a numeric id and a Hebrew label. Only the id is safe
 * to branch on, and the important detail is that TWO ids mean active: a contact
 * created through the API is 10, and one moved back to Active after a bounce or
 * an unsubscribe is 30. Code that checks for 10 alone silently drops every
 * reactivated contact, so use `isMailable`.
 */
export const StatusId = {
  NotFound: 0,
  Active: 10,
  Reactivated: 30,
  Bounced: 40,
  Unsubscribed: 50,
} as const;

export type ContactStatusName =
  | 'not_found'
  | 'active'
  | 'active_reactivated'
  | 'bounced'
  | 'unsubscribed'
  | `unknown_${number}`;

export class ContactStatus {
  readonly id: number;

  /** The gateway's own label, in Hebrew for the real states. For display only. */
  readonly label: string;

  constructor(id: number, label = '') {
    this.id = id;
    this.label = label;
  }

  static fromResponse(body: Record<string, unknown>): ContactStatus {
    return new ContactStatus(Number(body.StatusID ?? StatusId.NotFound), String(body.Status ?? ''));
  }

  get exists(): boolean {
    return this.id !== StatusId.NotFound;
  }

  get isMailable(): boolean {
    return this.id === StatusId.Active || this.id === StatusId.Reactivated;
  }

  get isBounced(): boolean {
    return this.id === StatusId.Bounced;
  }

  get isUnsubscribed(): boolean {
    return this.id === StatusId.Unsubscribed;
  }

  /** A stable English name for logs, independent of the gateway's label. */
  get name(): ContactStatusName {
    switch (this.id) {
      case StatusId.NotFound:
        return 'not_found';
      case StatusId.Active:
        return 'active';
      case StatusId.Reactivated:
        return 'active_reactivated';
      case StatusId.Bounced:
        return 'bounced';
      case StatusId.Unsubscribed:
        return 'unsubscribed';
      default:
        return `unknown_${this.id}`;
    }
  }
}
