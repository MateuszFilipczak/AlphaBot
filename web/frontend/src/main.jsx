import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import PositionDetail from "./pages/PositionDetail.jsx";
import ChartLab from "./pages/ChartLab.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/position/:ticker" element={<PositionDetail />} />
        </Route>
        {/* styling playground — standalone, deliberately unlinked from the UI */}
        <Route path="/lab" element={<ChartLab />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
