import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import PositionDetail from "./pages/PositionDetail.jsx";
import ModulePlaceholder from "./pages/ModulePlaceholder.jsx";
import Budget from "./pages/Budget.jsx";
import ChartLab from "./pages/ChartLab.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Giełda module — the working investment app */}
        <Route element={<App />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/position/:ticker" element={<PositionDetail />} />
        </Route>
        {/* Budżet module */}
        <Route path="/budzet" element={<Budget />} />
        {/* remaining modules — placeholders for now */}
        <Route path="/krypto" element={<ModulePlaceholder moduleKey="crypto" />} />
        {/* styling playground — standalone, deliberately unlinked from the UI */}
        <Route path="/lab" element={<ChartLab />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
