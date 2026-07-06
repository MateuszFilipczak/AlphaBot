import ModuleBar, { MODULES } from "../components/ModuleNav.jsx";

// "W budowie" screen for modules that don't exist yet (Budżet, Krypto). Shares
// the ModuleBar so switching back to Giełda is one click.
export default function ModulePlaceholder({ moduleKey }) {
  const m = MODULES.find((x) => x.key === moduleKey);
  return (
    <div className="app">
      <ModuleBar />
      <div className="module-soon">
        <p className="soon-badge">Moduł „{m?.label}" w budowie</p>
        <p className="muted">
          Wróć do modułu <b>Giełda</b>, aby zarządzać portfelami inwestycyjnymi.
        </p>
      </div>
    </div>
  );
}
