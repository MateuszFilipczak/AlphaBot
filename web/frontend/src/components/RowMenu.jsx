import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ⋯ context menu. Rendered through a portal with position:fixed so overflow
// containers can't clip it; flips upward when there's no room below.
// items: [{ label, danger?, onClick }]
const ITEM_HEIGHT = 35;
const MENU_WIDTH = 190;

export default function RowMenu({ items, label = "Menu" }) {
  const [pos, setPos] = useState(null); // null = closed, {left, top} = open
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const toggle = () => {
    if (pos) {
      setPos(null);
      return;
    }
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = items.length * ITEM_HEIGHT + 8;
    const flipUp = rect.bottom + menuH + 8 > window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      top: flipUp ? rect.top - menuH - 4 : rect.bottom + 4,
    });
  };

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    // fixed positioning goes stale on scroll/resize — just close
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  return (
    <>
      <button ref={btnRef} className="kebab" aria-label={label} onClick={toggle}>
        ⋯
      </button>
      {pos &&
        createPortal(
          <div
            ref={menuRef}
            className="menu-pop"
            style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: MENU_WIDTH }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                className={item.danger ? "danger-item" : ""}
                onClick={() => {
                  setPos(null);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
