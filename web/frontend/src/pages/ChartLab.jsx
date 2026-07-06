import { useRef, useState } from "react";
import { Link } from "react-router-dom";

// ---- Chart lab (/lab) --------------------------------------------------------
// Round 12: category manager redesign proposals + reordering. Interactive on
// sample categories (drag or arrows actually move items).

const CATS = [
  { id: 1, name: "Mieszkanie", color: "#3b82f6" },
  { id: 2, name: "Media", color: "#06b6d4" },
  { id: 3, name: "Transport", color: "#f59e0b" },
  { id: 4, name: "Jedzenie", color: "#22c55e" },
  { id: 5, name: "Zdrowie", color: "#ef4444" },
  { id: 6, name: "Rozrywka", color: "#a855f7" },
  { id: 7, name: "Subskrypcje", color: "#ec4899" },
  { id: 8, name: "Ubezpieczenia", color: "#eab308" },
  { id: 9, name: "Inne", color: "#94a3b8" },
];

function useOrder(init) {
  const [items, setItems] = useState(init);
  const move = (i, dir) => setItems((a) => {
    const j = i + dir;
    if (j < 0 || j >= a.length) return a;
    const b = [...a]; [b[i], b[j]] = [b[j], b[i]]; return b;
  });
  const drop = (from, to) => setItems((a) => {
    if (from == null || from === to) return a;
    const b = [...a]; const [m] = b.splice(from, 1); b.splice(to, 0, m); return b;
  });
  return { items, move, drop };
}

// C1 · Drag & drop z uchwytem
function C1() {
  const { items, drop } = useOrder(CATS);
  const drag = useRef(null);
  const [over, setOver] = useState(null);
  return (
    <div className="cm-list">
      {items.map((c, i) => (
        <div
          key={c.id}
          className={`cm-row ${over === i ? "cm-over" : ""}`}
          draggable
          onDragStart={() => (drag.current = i)}
          onDragOver={(e) => { e.preventDefault(); setOver(i); }}
          onDragLeave={() => setOver(null)}
          onDrop={() => { drop(drag.current, i); drag.current = null; setOver(null); }}
        >
          <span className="cm-handle" title="Przeciągnij">⠿</span>
          <span className="cm-swatch" style={{ background: c.color }} />
          <span className="cm-name">{c.name}</span>
          <div className="cm-actions">
            <button title="Edytuj">✎</button>
            <button className="danger" title="Usuń">✕</button>
          </div>
        </div>
      ))}
      <button className="cm-add-row">+ Dodaj kategorię</button>
    </div>
  );
}

// C2 · Strzałki góra/dół
function C2() {
  const { items, move } = useOrder(CATS);
  return (
    <div className="cm-list">
      {items.map((c, i) => (
        <div className="cm-row" key={c.id}>
          <span className="cm-swatch" style={{ background: c.color }} />
          <span className="cm-name">{c.name}</span>
          <div className="cm-arrows">
            <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="W górę">↑</button>
            <button disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="W dół">↓</button>
          </div>
          <div className="cm-actions">
            <button title="Edytuj">✎</button>
            <button className="danger" title="Usuń">✕</button>
          </div>
        </div>
      ))}
      <button className="cm-add-row">+ Dodaj kategorię</button>
    </div>
  );
}

// C3 · Chipy (przeciągane)
function C3() {
  const { items, drop } = useOrder(CATS);
  const drag = useRef(null);
  return (
    <div className="cm-chips">
      {items.map((c, i) => (
        <span
          key={c.id}
          className="cm-chip"
          draggable
          onDragStart={() => (drag.current = i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { drop(drag.current, i); drag.current = null; }}
          style={{ borderColor: c.color }}
        >
          <i style={{ background: c.color }} />
          {c.name}
          <button className="cm-chip-x" title="Usuń">✕</button>
        </span>
      ))}
      <button className="cm-chip cm-chip-add">+ Dodaj</button>
    </div>
  );
}

// C4 · Dwupanelowy (lista + edytor)
function C4() {
  const { items, move } = useOrder(CATS);
  const [sel, setSel] = useState(items[0].id);
  const cur = items.find((c) => c.id === sel) ?? items[0];
  return (
    <div className="cm-split">
      <div className="cm-split-list">
        {items.map((c, i) => (
          <div key={c.id} className={`cm-split-row ${c.id === sel ? "on" : ""}`} onClick={() => setSel(c.id)}>
            <span className="cm-swatch" style={{ background: c.color }} />
            <span className="cm-name">{c.name}</span>
            <div className="cm-arrows">
              <button disabled={i === 0} onClick={(e) => { e.stopPropagation(); move(i, -1); }}>↑</button>
              <button disabled={i === items.length - 1} onClick={(e) => { e.stopPropagation(); move(i, 1); }}>↓</button>
            </div>
          </div>
        ))}
        <button className="cm-add-row">+ Dodaj</button>
      </div>
      <div className="cm-editor">
        <div className="cm-editor-head"><span className="cm-swatch lg" style={{ background: cur.color }} />{cur.name}</div>
        <label className="cm-lbl">Nazwa</label>
        <input className="cm-input" defaultValue={cur.name} key={cur.id + "n"} />
        <label className="cm-lbl">Kolor</label>
        <input type="color" className="cm-color" defaultValue={cur.color} key={cur.id + "c"} />
        <div className="cm-editor-actions">
          <button className="btn small danger">Usuń kategorię</button>
        </div>
      </div>
    </div>
  );
}

function LabCard({ title, desc, children }) {
  return (
    <div className="lab-card lab-card-wide">
      <h3>{title}</h3>
      <p className="lab-desc">{desc}</p>
      <div className="cm-stage">
        <div className="cm-toggle"><button className="on">Wydatki</button><button>Wpływy</button></div>
        {children}
      </div>
    </div>
  );
}

export default function ChartLab() {
  return (
    <div className="app lab">
      <Link className="back" to="/">← Wróć do aplikacji</Link>
      <h1>
        Laboratorium — runda 12{" "}
        <span className="instr-name">menu kategorii + zmiana kolejności · 4 propozycje (klikalne)</span>
      </h1>
      <p className="note">
        Każda propozycja pozwala zmienić kolejność — przeciągnij element albo użyj strzałek. Kolejność
        z tego menu steruje układem w liście wydatków i na pasku struktury.
      </p>
      <LabCard title="C1 · Lista z uchwytem (drag & drop)" desc="Czyste wiersze: uchwyt do przeciągania, próbka koloru, nazwa, akcje po prawej. Przeciągnij wiersz, żeby zmienić kolejność.">
        <C1 />
      </LabCard>
      <LabCard title="C2 · Strzałki góra/dół" desc="Bez przeciągania — kolejność zmieniasz strzałkami ↑↓. Najprostsze i najpewniejsze, działa wszędzie.">
        <C2 />
      </LabCard>
      <LabCard title="C3 · Chipy" desc="Kategorie jako kolorowe piguły w jednym bloku, przeciągane między sobą. Zwarte i wizualne; edycja po kliknięciu.">
        <C3 />
      </LabCard>
      <LabCard title="C4 · Dwupanelowy" desc="Po lewej lista (ze strzałkami), po prawej edytor wybranej kategorii (nazwa, kolor, usuń). Najwięcej miejsca, jak panel ustawień.">
        <C4 />
      </LabCard>
    </div>
  );
}
