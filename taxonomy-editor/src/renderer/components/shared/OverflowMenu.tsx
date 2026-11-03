// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect } from 'react';
import './OverflowMenu.css';

export type OverflowMenuEntry =
  | { type: 'item'; key: string; label: string; onClick: () => void; danger?: boolean; className?: string }
  | { type: 'divider' }
  | { type: 'label'; text: string };

interface OverflowMenuProps {
  entries: OverflowMenuEntry[];
  triggerClassName?: string;
}

export function OverflowMenu({ entries, triggerClassName }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="overflow-menu-wrapper" ref={menuRef}>
      <button
        className={triggerClassName ?? 'btn btn-ghost btn-sm overflow-menu-trigger'}
        onClick={() => setOpen(!open)}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded={open}
      >&hellip;</button>
      {open && (
        <div className="overflow-menu-dropdown" role="menu">
          {entries.map((entry, i) => {
            if (entry.type === 'divider') return <div key={`d${i}`} className="overflow-menu-divider" />;
            if (entry.type === 'label') return <div key={`l${i}`} className="overflow-menu-section-label">{entry.text}</div>;
            const cls = ['overflow-menu-item', entry.danger && 'overflow-menu-danger', entry.className].filter(Boolean).join(' ');
            return (
              <button key={entry.key} className={cls} role="menuitem" onClick={() => { entry.onClick(); setOpen(false); }}>
                {entry.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
