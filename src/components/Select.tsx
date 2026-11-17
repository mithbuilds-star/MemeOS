import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export type SelectOption = { value: string; label: string };

export function Select({ value, onChange, options, placeholder = "Select", disabled = false, defaultValue, defaultLabel, searchable = true }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  defaultValue?: string;
  defaultLabel?: string;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const displayOptions = useMemo(() => {
    if (defaultValue === undefined) return options;
    const existing = options.find((o) => o.value === defaultValue);
    const fallback: SelectOption = {
      value: defaultValue,
      label: defaultLabel || (defaultValue === "" ? placeholder : `Default · ${existing?.label || placeholder}`),
    };
    return existing
      ? options.map((o) => o.value === defaultValue ? fallback : o)
      : [fallback, ...options];
  }, [options, defaultValue, defaultLabel, placeholder]);
  const selected = displayOptions.find((o) => o.value === value);
  const filtered = useMemo(
    () => displayOptions.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())),
    [displayOptions, query]
  );

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (o: SelectOption) => {
    onChange(o.value);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === "Home") { e.preventDefault(); setActive(0); }
    if (e.key === "End") { e.preventDefault(); setActive(Math.max(filtered.length - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) choose(filtered[active]); }
  };

  return (
    <div className="dd" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className={`dd-trigger${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => { setOpen(!open); setActive(0); }}
      >
        <span className={selected ? "" : "dd-placeholder"}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={16} className="dd-chevron" />
      </button>
      {open && (
        <div className="dd-menu" id={listId} role="listbox" aria-label={placeholder}>
          {searchable && displayOptions.length > 8 && (
            <div className="dd-search-wrap">
              <Search size={14} />
              <input
                className="dd-search"
                autoFocus
                placeholder="Search options"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              />
            </div>
          )}
          <div className="dd-list">
            {filtered.length === 0 && <div className="dd-empty">No options</div>}
            {filtered.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`dd-item${i === active ? " active" : ""}${o.value === value ? " selected" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              >
                <span>{o.label}</span>
                {o.value === value && <Check size={14} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
