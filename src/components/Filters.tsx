import { useEffect, useRef, useState } from 'react';

/**
 * The one filter control, used on every screen that filters.
 *
 * Before this there were three: Overview opened pill popovers, Call logs mixed
 * a native select with a row of segmented buttons, and Interventions used three
 * more native selects. Same job, three interaction models — so the same action
 * looked and behaved differently depending on which screen you were on.
 *
 * MULTI-SELECT IS KEPT rather than flattened. Overview's site filter takes
 * several sites at once, and unifying by dropping to single-select would have
 * removed a working filter to make the code tidier. So one component does both:
 * picking one closes the list, picking several does not.
 */

export interface FilterOption {
  value: string;
  label: string;
  /** Shown to the right of the label — a count, usually. Never invented. */
  hint?: string;
}

const trigger: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  height: 34,
  padding: '0 11px',
  borderRadius: 6,
  border: '1px solid var(--border-default)',
  background: '#fff',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink-900)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/**
 * One filter. `values` is always an array — a single-select simply holds at
 * most one — so the caller reads the same shape either way.
 */
export function FilterSelect({
  label,
  options,
  values,
  onChange,
  multi = false,
  allLabel,
}: {
  label: string;
  options: FilterOption[];
  values: string[];
  onChange: (next: string[]) => void;
  multi?: boolean;
  /** What "nothing selected" reads as. Defaults to the label. */
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape. A popover that can only be dismissed
  // by choosing something is a trap when you opened it to look.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = values.length > 0;
  const summary = !active
    ? allLabel ?? label
    : values.length === 1
      ? (options.find((o) => o.value === values[0])?.label ?? values[0])
      : `${values.length} selected`;

  const pick = (value: string) => {
    if (!multi) {
      // Choosing the current value clears it, so a single-select can be undone
      // without hunting for a reset.
      onChange(values[0] === value ? [] : [value]);
      setOpen(false);
      return;
    }
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        className="hue-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          ...trigger,
          borderColor: active ? 'var(--blue-500)' : 'var(--border-default)',
          color: active ? 'var(--blue-600)' : 'var(--ink-900)',
          background: active ? 'var(--blue-025)' : '#fff',
        }}
      >
        <span style={{ color: active ? 'var(--blue-600)' : 'var(--ink-500)' }}>{label}</span>
        <span>{summary}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : undefined, opacity: 0.7 }}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable={multi}
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            zIndex: 20,
            minWidth: 200,
            maxHeight: 320,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(16,24,40,.12)',
            padding: 4,
          }}
        >
          {options.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--ink-500)' }}>
              Nothing to filter by yet.
            </div>
          )}
          {options.map((o) => {
            const on = values.includes(o.value);
            return (
              <div
                key={o.value}
                role="option"
                aria-selected={on}
                tabIndex={0}
                onClick={() => pick(o.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(o.value);
                  }
                }}
                className="hue-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: on ? 'var(--blue-600)' : 'var(--ink-900)',
                  background: on ? 'var(--blue-025)' : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    flex: '0 0 14px',
                    borderRadius: multi ? 4 : 999,
                    border: `1px solid ${on ? 'var(--blue-500)' : 'var(--border-default)'}`,
                    background: on ? 'var(--blue-500)' : '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {on ? '✓' : ''}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{o.label}</span>
                {o.hint && (
                  <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{o.hint}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The row filters sit in, with the reset that only appears when there is
 * something to reset.
 */
export function FilterBar({
  children,
  onClear,
  dirty,
}: {
  children: React.ReactNode;
  onClear?: () => void;
  dirty?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      {children}
      {dirty && onClear && (
        <button
          className="hue-btn"
          onClick={onClear}
          style={{
            ...trigger,
            border: '1px solid transparent',
            background: 'transparent',
            color: 'var(--blue-600)',
            padding: '0 8px',
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
