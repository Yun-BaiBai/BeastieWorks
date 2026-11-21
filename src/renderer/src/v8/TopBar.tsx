import { tr } from '@shared/i18n';
import { leadName } from './leadName';
import type { ReactNode } from 'react';
import { toggleAppTheme, useAppTheme } from '../design/theme';

import { moneyText, type CostSure } from '@shared/v8/board';

export interface TopStats { working: number; slots: number; queued: number; waiting: number; spentUsd: number; spentSure?: CostSure; emergency?: boolean }

/** Logo, where you are, the four numbers that matter, day/night. The "waiting for you" number is the one in amber. */
export type StatDoor = 'crew' | 'queue' | 'lead' | 'ledger';

export function TopBar({ project, stats, onBack, projectSlot, onStat, onAgents, onSkills, onSetup }: { project: string; stats: TopStats; onBack?: () => void; projectSlot?: ReactNode; onStat?: (door: StatDoor) => void; onAgents?: () => void; onSkills?: () => void; onSetup?: () => void }) {
  const theme = useAppTheme();
  return (
    <header className="v8-top">
      <div className="v8-logo" aria-label="Beastie Works">BEASTIE WORKS</div>
      {onBack && <button type="button" className="v8-back" onClick={onBack}>{tr('← 回调度台')}</button>}
      {projectSlot ?? <div className="v8-crumb">{tr('小怪工坊')}<span>/</span>{project}</div>}
      {onAgents && <button type="button" className="v8-back" onClick={onAgents}>{tr('agent 名单')}</button>}
      {onSkills && <button type="button" className="v8-back" onClick={onSkills}>{tr('技能库')}</button>}
      {onSetup && <button type="button" className="v8-back" onClick={onSetup}>{tr('设置')}</button>}
      <div className="v8-stats">
        {/* Each number opens the page that explains it. */}
        <button type="button" className="v8-stat" onClick={() => onStat?.('crew')} aria-label={tr('进行中 {0}，打开小怪名册', [stats.working])}><span className="v8-cap">{tr('进行中')}</span><b>{stats.working}<i>/ {stats.slots}{stats.emergency ? '+1' : ''} {tr(' 名额')}</i></b></button>
        <button type="button" className="v8-stat" onClick={() => onStat?.('queue')} aria-label={tr('排队 {0}，打开排队', [stats.queued])}><span className="v8-cap">{tr('排队')}</span><b>{stats.queued}</b></button>
        <button type="button" className={'v8-stat' + (stats.waiting > 0 ? ' is-hot' : '')} onClick={() => onStat?.('lead')} aria-label={tr('等你 {0}，打开{1}', [stats.waiting, leadName()])}><span className="v8-cap">{tr('等你')}</span><b>{stats.waiting}</b></button>
        <button type="button" className="v8-stat" onClick={() => onStat?.('ledger')} aria-label={tr('今日花费 {0}，打开账本', [moneyText(stats.spentUsd, stats.spentSure ?? 'exact')])} title={stats.spentSure === 'estimated' ? tr('有的 agent 不报美元，按它用的词元数和官方价格估算') : stats.spentSure === 'partial' ? tr('有的花费算不出来（模型不在价格表上），实际比这个多') : undefined}><span className="v8-cap">{tr('今日花费')}</span><b>{moneyText(stats.spentUsd, stats.spentSure ?? 'exact')}</b></button>
        <button type="button" className="v8-sticker v8-icon-btn" onClick={() => toggleAppTheme()}
          aria-label={theme === 'dark' ? tr('切换到白天') : tr('切换到夜晚')}>{theme === 'dark' ? '☾' : '☀'}</button>
      </div>
    </header>
  );
}
