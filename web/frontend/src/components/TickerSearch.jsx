import { useEffect, useRef, useState } from "react";
import { searchTickers } from "../api.js";

// Autocomplete over the backend's Yahoo search proxy (/api/search).
// Debounced; shows symbol + company name + exchange.
export default function TickerSearch({ value, onChange, onSelect, disabled }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const timer = useRef(null);
  const rootRef = useRef(null);
  const skipNextSearch = useRef(false);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    clearTimeout(timer.current);
    const q = value.trim();
    if (q.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      searchTickers(q)
        .then((r) => {
          setResults(r);
          setOpen(r.length > 0);
          setFocused(-1);
        })
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [value]);

  // close on outside click
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (item) => {
    skipNextSearch.current = true; // selecting shouldn't re-trigger a search
    onSelect(item);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === "Enter" && focused >= 0) {
      e.preventDefault();
      pick(results[focused]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="autocomplete" ref={rootRef}>
      <input
        value={value}
        disabled={disabled}
        placeholder="np. AAPL"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && (
        <div className="ac-list" role="listbox">
          {results.map((item, i) => (
            <div
              key={item.symbol}
              role="option"
              aria-selected={i === focused}
              className={`ac-item ${i === focused ? "focused" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
            >
              <span className="sym">{item.symbol}</span>
              <span className="nm">{item.name}</span>
              <span className="ex">{item.exchange}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
