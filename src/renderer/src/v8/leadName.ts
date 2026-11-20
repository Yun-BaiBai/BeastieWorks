/** The lead's name as the boss set it (requirement 26). Set from the board each time it arrives; 小怪A until then. */
let name = '小怪A';
export const leadName = (): string => name;
export const setLeadName = (n: string | undefined): void => { if (n && n.trim()) name = n.trim(); };
