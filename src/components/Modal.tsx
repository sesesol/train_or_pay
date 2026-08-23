/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertCircle, CheckCircle, Info, X } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'error' | 'success' | 'info';
  text: string;
  onRetry?: () => void;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2.5 w-11/12 max-w-md pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          id={`toast-${t.id}`}
          className={`pointer-events-auto flex items-start gap-3 p-4 rounded-2xl shadow-2xl border text-xs font-bold transition-all animate-in fade-in slide-in-from-bottom-3 duration-200 uppercase tracking-wider ${
            t.type === 'error'
              ? 'bg-red-950/90 text-red-100 border-red-500/40 shadow-red-950/50'
              : t.type === 'success'
              ? 'bg-black/90 text-[#DFFF00] border-[#DFFF00]/40 shadow-black'
              : 'bg-black/90 text-white border-white/20 shadow-black'
          }`}
        >
          {t.type === 'error' && <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />}
          {t.type === 'success' && <CheckCircle className="w-5 h-5 text-[#DFFF00] shrink-0 mt-0.5" />}
          {t.type === 'info' && <Info className="w-5 h-5 text-[#DFFF00] shrink-0 mt-0.5" />}

          <div className="flex-1 pr-1 font-mono">
            <p className="leading-snug normal-case">{t.text}</p>
            {t.onRetry && (
              <button
                type="button"
                id={`toast-retry-${t.id}`}
                onClick={t.onRetry}
                className="mt-2 text-xs font-black uppercase tracking-wider underline underline-offset-4 text-[#DFFF00] hover:text-white"
              >
                Erneut versuchen
              </button>
            )}
          </div>

          <button
            type="button"
            id={`toast-dismiss-${t.id}`}
            onClick={() => onDismiss(t.id)}
            className="text-white/40 hover:text-white p-1 cursor-pointer"
            aria-label="Schließen"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
};

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  requireInput?: string; // If set, user must type this string
  inputPlaceholder?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  description,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  isDestructive = false,
  requireInput,
  inputPlaceholder,
  onConfirm,
  onCancel,
}) => {
  const [typedInput, setTypedInput] = React.useState('');

  React.useEffect(() => {
    if (isOpen) setTypedInput('');
  }, [isOpen]);

  if (!isOpen) return null;

  const isConfirmedAllowed = !requireInput || typedInput.trim() === requireInput.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        id="confirm-modal-dialog"
        className="w-full max-w-sm bg-[#0A0A0A] border border-white/20 rounded-3xl p-6 shadow-2xl text-white flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <h3 className="text-xl font-black uppercase tracking-tight text-white">{title}</h3>
          <p className="text-xs text-white/60 leading-relaxed font-medium">{description}</p>
        </div>

        {requireInput && (
          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-[0.2em] font-black text-white/40">
              Tippe zur Bestätigung: <span className="font-mono text-[#DFFF00] font-black">{requireInput}</span>
            </label>
            <input
              type="text"
              id="confirm-modal-input"
              value={typedInput}
              onChange={(e) => setTypedInput(e.target.value)}
              placeholder={inputPlaceholder || requireInput}
              className="w-full px-4 py-3 bg-black/50 border border-white/15 rounded-2xl text-sm font-bold font-mono text-white focus:outline-hidden focus:border-[#DFFF00]"
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            id="confirm-modal-cancel-btn"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider text-white/60 hover:text-white bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            id="confirm-modal-confirm-btn"
            disabled={!isConfirmedAllowed}
            onClick={() => {
              if (isConfirmedAllowed) onConfirm();
            }}
            className={`px-5 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider transition-all shadow-lg cursor-pointer ${
              isDestructive
                ? 'bg-red-500 text-black hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed'
                : 'bg-[#DFFF00] text-black hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
