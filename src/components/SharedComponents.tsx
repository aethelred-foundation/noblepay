/**
 * SharedComponents — Shared UI primitives for NoblePay.
 *
 * Every component uses the dark-slate + brand-red design language, CSS-only
 * animations, and is fully SSR-safe (no window access outside useEffect).
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Shield,
  ExternalLink,
  Github,
  Twitter,
  X,
  Search,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  Menu,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';

// ============================================================================
// LiveDot
// ============================================================================

export interface LiveDotProps {
  color?: 'green' | 'red' | 'yellow';
  size?: 'sm' | 'md';
}

export function LiveDot({ color = 'green', size = 'sm' }: LiveDotProps) {
  const colorMap = {
    green: 'bg-emerald-500',
    red: 'bg-red-500',
    yellow: 'bg-yellow-500',
  };
  const ringMap = {
    green: 'bg-emerald-500/40',
    red: 'bg-red-500/40',
    yellow: 'bg-yellow-500/40',
  };
  const px = size === 'sm' ? 'h-2 w-2' : 'h-3 w-3';
  const ringPx = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';

  return (
    <span aria-hidden="true" className="relative inline-flex items-center justify-center">
      <span
        className={`absolute inline-flex rounded-full ${ringMap[color]} ${ringPx}`}
        style={{ animation: 'live-dot 2s ease-in-out infinite' }}
      />
      <span className={`relative inline-flex rounded-full ${colorMap[color]} ${px}`} />
    </span>
  );
}

// ============================================================================
// Badge
// ============================================================================

export interface BadgeProps {
  variant: 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'brand';
  children: React.ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  const styles: Record<string, string> = {
    success: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
    warning: 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20',
    error: 'bg-red-500/10 text-red-400 ring-red-500/20',
    info: 'bg-blue-500/10 text-blue-400 ring-blue-500/20',
    neutral: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
    brand: 'bg-red-500/10 text-red-400 ring-red-500/20',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[variant]}`}
    >
      {children}
    </span>
  );
}

// ============================================================================
// Modal
// ============================================================================

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ open, onClose, title, children, maxWidth = 'max-w-lg' }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        style={{ animation: 'modal-overlay-in 0.2s ease-out' }}
        onClick={onClose}
      />
      <div
        className={`relative ${maxWidth} w-full bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl`}
        style={{ animation: 'modal-content-in 0.2s ease-out' }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

// ============================================================================
// Drawer
// ============================================================================

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}

export function Drawer({ open, onClose, title, children, width = 'max-w-lg' }: DrawerProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        style={{ animation: 'modal-overlay-in 0.2s ease-out' }}
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-0 h-full ${width} w-full bg-slate-900 border-l border-slate-700/50 shadow-2xl overflow-y-auto`}
        style={{ animation: 'drawer-in 0.3s ease-out' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-slate-700/50 bg-slate-900">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

// ============================================================================
// Tabs
// ============================================================================

interface TabsProps {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex gap-1 p-1 bg-slate-800/50 rounded-lg">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            active === tab.id
              ? 'bg-slate-700 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// ToastContainer
// ============================================================================

export function ToastContainer() {
  const { notifications, removeNotification } = useApp();

  const iconMap = {
    success: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
    error: <AlertCircle className="w-5 h-5 text-red-400" />,
    warning: <AlertTriangle className="w-5 h-5 text-yellow-400" />,
    info: <Info className="w-5 h-5 text-blue-400" />,
  };

  const borderMap = {
    success: 'border-emerald-500/30',
    error: 'border-red-500/30',
    warning: 'border-yellow-500/30',
    info: 'border-blue-500/30',
  };

  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 max-w-sm">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`flex items-start gap-3 rounded-xl border ${borderMap[n.type]} bg-slate-900/95 backdrop-blur-xl px-4 py-3 shadow-lg`}
          style={{ animation: 'toast-in 0.3s ease-out' }}
        >
          {iconMap[n.type]}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">{n.title}</p>
            <p className="text-xs text-slate-400 mt-0.5">{n.message}</p>
          </div>
          <button
            onClick={() => removeNotification(n.id)}
            className="p-0.5 text-slate-500 hover:text-white transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// SearchOverlay (Cmd+K)
// ============================================================================

export function SearchOverlay() {
  const { searchOpen, setSearchOpen } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery('');
    }
  }, [searchOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, setSearchOpen]);

  if (!searchOpen) return null;

  const searchItems = [
    { label: 'Dashboard', href: '/', section: 'Pages' },
    { label: 'Payments', href: '/payments', section: 'Pages' },
    { label: 'Compliance Center', href: '/compliance', section: 'Pages' },
    { label: 'Business Registry', href: '/businesses', section: 'Pages' },
    { label: 'Analytics', href: '/analytics', section: 'Pages' },
    { label: 'Audit Trail', href: '/audit', section: 'Pages' },
    { label: 'Settings', href: '/settings', section: 'Pages' },
    { label: 'Initiate Payment', href: '/payments?action=new', section: 'Actions' },
    { label: 'Register Business', href: '/businesses?action=register', section: 'Actions' },
    { label: 'Export Audit Logs', href: '/audit?action=export', section: 'Actions' },
  ];

  const filtered = query
    ? searchItems.filter((item) =>
        item.label.toLowerCase().includes(query.toLowerCase()),
      )
    : searchItems;

  return (
    <div className="fixed inset-0 z-[80]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setSearchOpen(false)}
      />
      <div className="relative mx-auto mt-[15vh] max-w-xl px-4">
        <div className="bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/50">
            <Search className="w-5 h-5 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages, payments, businesses..."
              className="flex-1 bg-transparent text-white text-sm placeholder-slate-500 focus:outline-none"
            />
            <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-slate-700 px-1.5 py-0.5 text-2xs text-slate-500">
              ESC
            </kbd>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">No results found</p>
            ) : (
              filtered.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSearchOpen(false)}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  <span className="text-2xs text-slate-500 w-12">{item.section}</span>
                  {item.label}
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TopNav
// ============================================================================

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/payments', label: 'Payments' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/businesses', label: 'Businesses' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/audit', label: 'Audit' },
  { href: '/treasury', label: 'Treasury' },
  { href: '/liquidity', label: 'Liquidity' },
  { href: '/streaming', label: 'Streaming' },
  { href: '/ai-compliance', label: 'AI Compliance' },
  { href: '/risk-monitor', label: 'Risk Monitor' },
  { href: '/invoice-financing', label: 'Invoice Financing' },
  { href: '/fx-hedging', label: 'FX Hedging' },
  { href: '/payment-channels', label: 'Payment Channels' },
  { href: '/regulatory-reporting', label: 'Regulatory' },
  { href: '/cross-chain', label: 'Cross-Chain' },
];

export function TopNav({ activePage }: { activePage?: string }) {
  const router = useRouter();
  const { wallet, connectWallet, disconnectWallet } = useApp();
  const currentPath = activePage || router.pathname;

  return (
    <nav className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 text-white font-bold text-lg">
            <Shield className="h-6 w-6 text-red-500" />
            NoblePay
          </Link>
          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const isActive = currentPath === link.href || currentPath === link.label.toLowerCase();
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {wallet.connected ? (
            <button
              onClick={disconnectWallet}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {wallet.address.slice(0, 8)}...{wallet.address.slice(-4)}
            </button>
          ) : (
            <button
              onClick={connectWallet}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

// ============================================================================
// Footer
// ============================================================================

export function Footer() {
  return (
    <footer className="border-t border-slate-800 bg-slate-950 py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
          <div className="flex items-center gap-2 text-slate-400">
            <Shield className="h-5 w-5 text-red-500" />
            <span className="font-medium text-white">NoblePay</span>
            <span className="text-sm">by Aethelred</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500">
            <a href="https://aethelred.io" target="_blank" rel="noopener noreferrer" className="hover:text-slate-300 transition-colors inline-flex items-center gap-1">
              Docs <ExternalLink className="h-3 w-3" />
            </a>
            <a href="https://github.com/aethelred" target="_blank" rel="noopener noreferrer" className="hover:text-slate-300 transition-colors">
              <Github className="h-4 w-4" />
            </a>
            <a href="https://twitter.com/aethelred" target="_blank" rel="noopener noreferrer" className="hover:text-slate-300 transition-colors">
              <Twitter className="h-4 w-4" />
            </a>
          </div>
          <p className="text-xs text-slate-600">&copy; 2026 Aethelred. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
