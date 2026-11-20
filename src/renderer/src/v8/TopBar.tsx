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
      {onBack && <button type="button" className="v8-back" onClick={onBack}>← 回调度台</button>}
      {projectSlot ?? <div className="v8-crumb">小怪工坊<span>/</span>{project}</div>}
      {onAgents && <button type="button" className="v8-back" onClick={onAgents}>agent 名单</button>}
      {onSkills && <button type="button" className="v8-back" onClick={onSkills}>技能库</button>}
      {onSetup && <button type="button" className="v8-back" onClick={onSetup}>设置</button>}
      <div className="v8-stats">
        {/* Each number opens the page that explains it. */}
        <button type="button" className="v8-stat" onClick={() => onStat?.('crew')} aria-label={`进行中 ${stats.working}，打开小怪名册`}><span className="v8-cap">进行中</span><b>{stats.working}<i>/ {stats.slots}{stats.emergency ? '+1' : ''} 名额</i></b></button>
        <button type="button" className="v8-stat" onClick={() => onStat?.('queue')} aria-label={`排队 ${stats.queued}，打开排队`}><span className="v8-cap">排队</span><b>{stats.queued}</b></button>
        <button type="button" className={'v8-stat' + (stats.waiting > 0 ? ' is-hot' : '')} onClick={() => onStat?.('lead')} aria-label={`等你 ${stats.waiting}，打开${leadName()}`}><span className="v8-cap">等你</span><b>{stats.waiting}</b></button>
        <button type="button" className="v8-stat" onClick={() => onStat?.('ledger')} aria-label={`今日花费 ${moneyText(stats.spentUsd, stats.spentSure ?? 'exact')}，打开账本`} title={stats.spentSure === 'estimated' ? '有的 agent 不报美元，按它用的词元数和官方价格估算' : stats.spentSure === 'partial' ? '有的花费算不出来（模型不在价格表上），实际比这个多' : undefined}><span className="v8-cap">今日花费</span><b>{moneyText(stats.spentUsd, stats.spentSure ?? 'exact')}</b></button>
        <button type="button" className="v8-sticker v8-icon-btn" onClick={() => toggleAppTheme()}
          aria-label={theme === 'dark' ? '切换到白天' : '切换到夜晚'}>{theme === 'dark' ? '☾' : '☀'}</button>
      </div>
    </header>
  );
}
