import { useState } from 'react';
import { localDateString } from './store';
import { ChartView } from './ui/ChartView';
import { HistoryView } from './ui/HistoryView';
import { SettingsView } from './ui/SettingsView';
import { SyncDialog } from './ui/SyncDialog';
import { TodayView } from './ui/TodayView';
import { useGitHub } from './ui/useGitHub';

type Tab = 'today' | 'history' | 'chart' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'today', label: 'Dziś' },
  { key: 'history', label: 'Historia' },
  { key: 'chart', label: '7 dni' },
  { key: 'settings', label: 'Ustawienia' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [date, setDate] = useState(localDateString());
  const gh = useGitHub();

  return (
    <div className="app">
      <header>
        <h1>Monitor zmęczenia</h1>
      </header>
      <main>
        {tab === 'today' && <TodayView gh={gh} date={date} setDate={setDate} onOpenSettings={() => setTab('settings')} />}
        {tab === 'history' && (
          <HistoryView
            onEdit={(d) => {
              setDate(d);
              setTab('today');
            }}
          />
        )}
        {tab === 'chart' && <ChartView />}
        {tab === 'settings' && <SettingsView gh={gh} />}
      </main>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <SyncDialog gh={gh} />
    </div>
  );
}
