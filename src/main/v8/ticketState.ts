import type { AssignmentStatus, ReportKind, ReviewVerdict, TicketState } from '../../shared/v8/tickets';

/** The few facts a ticket's state depends on. Everything else (titles, text, slots) is display only. */
export interface TicketFacts {
  ended: null | 'done' | 'stopped';
  /** The ticket's newest assignment. */
  latestAssignment: null | { id: number; status: AssignmentStatus };
  /** The newest report handed in under that same assignment, if any. */
  latestReport: null | { kind: ReportKind; review: ReviewVerdict };
  /** The newest assignment ended because the account ran out of quota, and the ticket is waiting to go on. */
  quotaWait?: boolean;
}

/**
 * Spec section 2. Pure: the same facts always give the same state.
 *
 * A report always ends its assignment, and anything the boss says afterwards (an answer, a nudge, a retry)
 * opens a new one. So "the boss has not replied yet" is simply "the newest assignment is the one that reported".
 */
export function ticketState(f: TicketFacts): TicketState {
  if (f.ended === 'done') return 'DONE';
  if (f.ended === 'stopped') return 'STOPPED';
  const a = f.latestAssignment;
  if (!a || a.status === 'PENDING') return 'QUEUED';
  if (a.status === 'RUNNING') return 'WORKING';
  const r = f.latestReport;
  if (!r) return f.quotaWait ? 'WAITING_QUOTA' : 'IDLE';
  switch (r.kind) {
    case 'question': return 'ANSWER';
    case 'nothing': return 'REVIEW';
    case 'done':
      // Waiting for review is still the gremlins' business. A rejection under the limit always opens a new
      // assignment, so a rejected report that is still the newest one means review gave up: the boss decides.
      return r.review === 'pending' ? 'WORKING' : 'REVIEW';
    case 'blocked': return 'BLOCKED';
    case 'failed': return 'FAILED';
  }
}
