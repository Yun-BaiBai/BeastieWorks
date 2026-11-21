import { tr } from '@shared/i18n';
import { leadName } from './leadName';
import { GREMLIN_ART, type GremlinCast, type GremlinExtraPose, type GremlinPose } from '../projects/office/gremlinArt';
import type { TicketState } from '@shared/v8/tickets';

/**
 * Which gremlin and which pose (前端方向.md, "状态和小怪姿势"). The lead is always the boss gremlin; review is
 * always the lanky one-eye in the scarf; slots take turns over six workers, so up to six gremlins working at once never share a face.
 */
export const WORKERS: GremlinCast[] = ['alien', 'tri', 'jelly', 'blob', 'fuzz', 'spike'];
export const slotCast = (order: number): GremlinCast => WORKERS[((order % WORKERS.length) + WORKERS.length) % WORKERS.length];

export interface CrewMember { cast: GremlinCast; name: string; title: string; role: 'lead' | 'reviewer' | 'worker' }
/** Everyone in the workshop, for the badge wall. */
export const CREW: CrewMember[] = [
  { cast: 'boss', get name() { return leadName(); }, title: tr('主理'), role: 'lead' },
  { cast: 'lanky', name: tr('围巾'), title: tr('审查'), role: 'reviewer' },
  { cast: 'alien', name: tr('四眼'), title: tr('干活'), role: 'worker' },
  { cast: 'tri', name: tr('三眼'), title: tr('干活'), role: 'worker' },
  { cast: 'jelly', name: tr('水母'), title: tr('干活'), role: 'worker' },
  { cast: 'blob', name: tr('团子'), title: tr('干活'), role: 'worker' },
  { cast: 'fuzz', name: tr('毛毛'), title: tr('干活'), role: 'worker' },
  { cast: 'spike', name: tr('刺刺'), title: tr('干活'), role: 'worker' },
];

export type AnyPose = GremlinPose | GremlinExtraPose;

/** What a worker does in each state. Poses a character lacks fall back to a base pose in `art`. */
export function poseFor(state: TicketState | null, phase: 'working' | 'checking' | null = null): AnyPose {
  switch (state) {
    case 'WORKING': return phase === 'checking' ? 'checking' : 'working';
    case 'ANSWER': return 'held';
    case 'REVIEW': return 'reporting';
    case 'BLOCKED': return 'stuck';
    case 'FAILED': return 'stalled';
    case 'DONE': return 'celebrating';
    case 'WAITING_QUOTA': return 'waiting_quota';
    case 'QUEUED': case 'IDLE': case null: return 'long_wait';
    default: return 'idle';
  }
}

/** Extra poses map to the nearest base pose for characters that do not have them. */
const FALLBACK: Record<GremlinExtraPose, GremlinPose> = {
  reporting: 'review', rejected: 'stalled', celebrating: 'review', stuck: 'stalled',
  approve: 'review', reject: 'held', reading: 'checking', unimpressed: 'held',
  pointing: 'working', thumbs_up: 'review', listening: 'idle', shrugging: 'held',
};

export const art = (cast: GremlinCast, pose: AnyPose) => {
  const set = GREMLIN_ART[cast];
  return (set[pose as GremlinExtraPose] ?? set[(FALLBACK as Record<string, GremlinPose>)[pose] ?? (pose as GremlinPose)] ?? set.idle).src;
};
