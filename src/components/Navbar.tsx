/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Calendar,
  DollarSign,
  History,
  Settings,
  RefreshCw,
  Dumbbell,
  Users,
  ChevronDown,
} from 'lucide-react';
import { SessionMeta, UserProfile } from '../types.ts';

export type ActiveTab = 'week' | 'debts' | 'history' | 'settings';

interface NavbarProps {
  currentTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  session: SessionMeta;
  currentUser: UserProfile;
  onRefresh: () => void;
  isRefreshing: boolean;
  onSwitchSession: () => void;
  openDebtsCount: number;
}

export const TopNavbar: React.FC<NavbarProps> = ({
  session,
  currentUser,
  onRefresh,
  isRefreshing,
  onSwitchSession,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-[#0A0A0A]/90 backdrop-blur-md border-b border-white/10 px-4 py-3">
      <div className="max-w-md mx-auto flex items-center justify-between gap-2">
        {/* Session Switcher / Brand */}
        <button
          type="button"
          id="navbar-session-switcher-btn"
          onClick={onSwitchSession}
          className="flex items-center gap-2.5 p-1.5 -ml-1.5 rounded-2xl hover:bg-white/5 transition-colors text-left group cursor-pointer"
        >
          <div className="w-8 h-8 rounded-xl bg-[#DFFF00] flex items-center justify-center text-black font-black shrink-0 shadow-xs">
            <Dumbbell className="w-4 h-4 stroke-[2.5]" />
          </div>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-black text-white text-sm uppercase tracking-tight truncate group-hover:text-[#DFFF00] transition-colors">
                {session.name}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-white/40 shrink-0 group-hover:text-[#DFFF00]" />
            </div>
            <span className="text-[10px] font-mono text-white/50 tracking-wider">
              CODE: <strong className="text-[#DFFF00] font-bold">{session.code}</strong>
            </span>
          </div>
        </button>

        {/* Right actions: Refresh button & User Badge */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            id="navbar-refresh-btn"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="p-2 text-white/50 hover:text-[#DFFF00] hover:bg-white/5 rounded-xl transition-colors cursor-pointer"
            title="Session aktualisieren"
            aria-label="Session aktualisieren"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-[#DFFF00]' : ''}`} />
          </button>

          <button
            type="button"
            id="navbar-user-badge"
            onClick={onSwitchSession}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-bold text-white uppercase tracking-wider cursor-pointer transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-[#DFFF00]" />
            <span className="truncate max-w-[85px]">{currentUser.displayName}</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export const BottomNavbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  openDebtsCount,
}) => {
  const tabs = [
    { id: 'week' as const, label: 'Diese Woche', icon: Calendar },
    { id: 'debts' as const, label: 'Schulden', icon: DollarSign, badge: openDebtsCount > 0 ? openDebtsCount : null },
    { id: 'history' as const, label: 'Verlauf', icon: History },
    { id: 'settings' as const, label: 'Session', icon: Settings },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-[#0A0A0A]/95 backdrop-blur-md border-t border-white/10 px-2 py-1.5 pb-safe">
      <div className="max-w-md mx-auto grid grid-cols-4 gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              id={`bottom-nav-${tab.id}`}
              onClick={() => onSelectTab(tab.id)}
              className={`min-h-[48px] py-1 px-2 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer select-none ${
                isActive
                  ? 'text-[#DFFF00] bg-[#DFFF00]/10 font-black'
                  : 'text-white/40 hover:text-white hover:bg-white/5 font-bold'
              }`}
            >
              <div className="relative">
                <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : 'stroke-2'}`} />
                {tab.badge && (
                  <span className="absolute -top-1.5 -right-2 px-1.5 py-0.2 bg-red-500 text-white font-black text-[9px] rounded-full ring-2 ring-[#0A0A0A] animate-pulse">
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className="text-[9px] uppercase tracking-widest leading-none">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
