/** The lead's name as the boss set it (requirement 26). Set from the board each time it arrives; 主理小怪 until then. */
import { tr } from '@shared/i18n';
let name = tr('主理小怪');
export const leadName = (): string => name;
export const setLeadName = (n: string | undefined): void => { if (n && n.trim()) name = n.trim(); };
