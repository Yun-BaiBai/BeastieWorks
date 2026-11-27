import { contextBridge, ipcRenderer } from 'electron';
import type { V8Settings } from '../shared/v8/settings';

/**
 * The window's way into the app (小怪工坊 is the v8 workbench only, 老板 2026-11-20): the app's settings, opening a
 * web page in the person's browser, and the workbench itself.
 */

/** The app's settings file (config.json in the app's data folder). Other keys an older version wrote are kept. */
export interface AppConfig {
  /** A8: the interface language: Chinese, English, or the computer's own. */
  uiLanguage?: 'zh' | 'en' | 'system';
  v8?: V8Settings;
}

const api = {
  /** A8: the interface language, known before the window shows anything. */
  uiLanguage: ipcRenderer.sendSync('i18n:lang') as 'zh' | 'en',
  /** A8: choose the language; the app restarts afterwards. */
  setUiLanguage: (choice: 'zh' | 'en' | 'system'): Promise<'zh' | 'en'> => ipcRenderer.invoke('i18n:set', choice),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('config:update', patch),
  /** Open an https page (a sign-in page, a link in a report) in the person's browser. */
  /** A4: open Windows' voice typing (Win+H) over the focused text box. */
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('app:openExternal', url),
  v8: {
    board: (): Promise<import('../shared/v8/board').BoardData> => ipcRenderer.invoke('v8:board'),
    ticket: (id: number): Promise<{ view: import('../shared/v8/tickets').TicketView; messages: import('../shared/v8/tickets').V8Message[]; log: import('../shared/v8/board').WorkLogLine[]; files: import('../shared/v8/board').FileChange[] }> => ipcRenderer.invoke('v8:ticket', id),
    slot: (slotId: string): Promise<import('../shared/v8/board').SlotDetail | null> => ipcRenderer.invoke('v8:slot', slotId),
    delivery: (id: number): Promise<import('../shared/v8/board').DeliveryDetail | null> => ipcRenderer.invoke('v8:delivery', id),
    review: (): Promise<import('../shared/v8/board').ReviewDetail> => ipcRenderer.invoke('v8:review'),
    ledger: (): Promise<import('../shared/v8/board').LedgerDetail> => ipcRenderer.invoke('v8:ledger'),
    archive: (): Promise<import('../shared/v8/board').ArchiveItem[]> => ipcRenderer.invoke('v8:archive'),
    timeline: (id: number): Promise<import('../shared/v8/board').TimelineItem[]> => ipcRenderer.invoke('v8:timeline', id),
    projects: (): Promise<Array<{ key: string; root: string | null; name: string; createdAt: number; current: boolean; missing: boolean }>> => ipcRenderer.invoke('v8:projects'),
    chooseFolder: (): Promise<{ path: string; name: string; git: boolean } | null> => ipcRenderer.invoke('v8:chooseFolder'),
    say: (text: string): Promise<number> => ipcRenderer.invoke('v8:say', text),
    tell: (id: number, text: string): Promise<void> => ipcRenderer.invoke('v8:tell', id, text),
    stop: (id: number): Promise<void> => ipcRenderer.invoke('v8:stop', id),
    accept: (id: number): Promise<void> => ipcRenderer.invoke('v8:accept', id),
    reviewAgain: (id: number): Promise<void> => ipcRenderer.invoke('v8:reviewAgain', id),
    reject: (id: number, why: string): Promise<void> => ipcRenderer.invoke('v8:reject', id, why),
    retry: (id: number, o?: { model?: string; fresh?: boolean }): Promise<void> => ipcRenderer.invoke('v8:retry', id, o ?? {}),
    resumeNow: (id: number): Promise<void> => ipcRenderer.invoke('v8:resumeNow', id),
    pickPlan: (roundtableId: number, which: 'A' | 'B'): Promise<number> => ipcRenderer.invoke('v8:pickPlan', roundtableId, which),
    switchAccount: (id: number, account: string | null): Promise<void> => ipcRenderer.invoke('v8:switchAccount', id, account),
    switchModel: (id: number, model: string | null): Promise<void> => ipcRenderer.invoke('v8:switchModel', id, model),
    switchEffort: (id: number, effort: string | null): Promise<void> => ipcRenderer.invoke('v8:switchEffort', id, effort),
    /** A12: split a big job as proposed, or do it whole. */
    decideSplit: (id: number, how: 'split' | 'whole'): Promise<number[]> => ipcRenderer.invoke('v8:decideSplit', id, how),
    /** A15: start a 工序链's next stage. */
    nextStage: (chainId: number): Promise<number> => ipcRenderer.invoke('v8:nextStage', chainId),
    /** A10: the project's notebook. */
    notes: (): Promise<import('../shared/v8/notes').NotesView> => ipcRenderer.invoke('v8:notes'),
    noteAdd: (text: string): Promise<import('../shared/v8/notes').NotesView> => ipcRenderer.invoke('v8:noteAdd', text),
    noteEdit: (id: number, text: string): Promise<import('../shared/v8/notes').NotesView> => ipcRenderer.invoke('v8:noteEdit', id, text),
    noteRemove: (id: number): Promise<import('../shared/v8/notes').NotesView> => ipcRenderer.invoke('v8:noteRemove', id),
    skills: (): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skills'),
    magpieModels: (fresh?: boolean): Promise<import('../shared/v8/agents').MagpieModelView[]> => ipcRenderer.invoke('v8:magpieModels', fresh === true),
    agentSize: (id: string): Promise<import('../shared/v8/agents').InstallSize> => ipcRenderer.invoke('v8:agentSize', id),
    agentInstall: (id: string): Promise<import('../shared/v8/agents').RosterView> => ipcRenderer.invoke('v8:agentInstall', id),
    /** Bytes of the agent on disk so far while it installs; null when it is not installing. */
    agentInstallProgress: (id: string): Promise<number | null> => ipcRenderer.invoke('v8:agentInstallProgress', id),
    agentUninstall: (id: string): Promise<import('../shared/v8/agents').RosterView> => ipcRenderer.invoke('v8:agentUninstall', id),
    skillsEnable: (ids: string[], on: boolean): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skillsEnable', ids, on),
    /** A5: the tools behind the skills that ship with the app. Size first (downloads nothing), then install. */
    skillToolSize: (skill: string): Promise<import('../shared/v8/agents').InstallSize> => ipcRenderer.invoke('v8:skillToolSize', skill),
    skillToolInstall: (skill: string): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skillToolInstall', skill),
    skillToolRemove: (skill: string): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skillToolRemove', skill),
    skillRemove: (id: string): Promise<{ how: 'deleted' | 'taken-out'; view: import('../shared/v8/skills').SkillLibraryView }> => ipcRenderer.invoke('v8:skillRemove', id),
    skillsRestore: (): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skillsRestore'),
    skillImport: (link: string): Promise<({ added: string[]; skipped: string[] } | { error: string }) & { view: import('../shared/v8/skills').SkillLibraryView }> => ipcRenderer.invoke('v8:skillImport', link),
    skillRetell: (id: string, agent: string): Promise<import('../shared/v8/skills').SkillLibraryView> => ipcRenderer.invoke('v8:skillRetell', id, agent),
    waitForQuota: (id: number): Promise<{ resetsAt: number | null }> => ipcRenderer.invoke('v8:waitForQuota', id),
    agentQuota: (id: string, fresh?: boolean): Promise<import('../shared/v8/agents').AgentQuota> => ipcRenderer.invoke('v8:agentQuota', id, fresh === true),
    front: (id: number): Promise<number> => ipcRenderer.invoke('v8:front', id),
    agents: (): Promise<import('../shared/v8/agents').RosterView> => ipcRenderer.invoke('v8:agents'),
    agentSay: (id: string, text: string): Promise<import('../shared/v8/agents').ChatTurn> => ipcRenderer.invoke('v8:agentSay', id, text),
    agentChoices: (id: string): Promise<import('../shared/v8/agents').SessionChoices> => ipcRenderer.invoke('v8:agentChoices', id),
    agentChoose: (id: string, kind: 'model' | 'effort', value: string): Promise<import('../shared/v8/agents').SessionChoices> => ipcRenderer.invoke('v8:agentChoose', id, kind, value),
    agentSignInStart: (id: string): Promise<import('../shared/v8/agents').SignInFlow> => ipcRenderer.invoke('v8:agentSignInStart', id),
    agentSignInCode: (id: string, flowId: string, code: string): Promise<import('../shared/v8/agents').SignInFlow> => ipcRenderer.invoke('v8:agentSignInCode', id, flowId, code),
    agentSignInStatus: (id: string, flowId: string): Promise<import('../shared/v8/agents').SignInFlow | null> => ipcRenderer.invoke('v8:agentSignInStatus', id, flowId),
    agentSignInCancel: (id: string): Promise<void> => ipcRenderer.invoke('v8:agentSignInCancel', id),
    agentChatClose: (id: string): Promise<void> => ipcRenderer.invoke('v8:agentChatClose', id),
    /** 语音输入 (requirement 67): whether the speech model is here, downloading it, and speech to text. */
    speechStatus: (): Promise<{ ready: boolean; size: number; downloading: { got: number } | null }> => ipcRenderer.invoke('v8:speechStatus'),
    speechDownload: (onProgress: (got: number) => void): Promise<{ ready: boolean; size: number }> => {
      const listen = (_e: unknown, got: number) => onProgress(got);
      ipcRenderer.on('v8:speechProgress', listen);
      return ipcRenderer.invoke('v8:speechDownload').finally(() => ipcRenderer.off('v8:speechProgress', listen));
    },
    speechTranscribe: (pcm: Float32Array): Promise<string> => ipcRenderer.invoke('v8:speechTranscribe', pcm),
    onChanged: (callback: () => void): (() => void) => { const handler = () => callback(); ipcRenderer.on('v8:changed', handler); return () => ipcRenderer.removeListener('v8:changed', handler); },
  },
};

contextBridge.exposeInMainWorld('cth', api);

export type CthApi = typeof api;
