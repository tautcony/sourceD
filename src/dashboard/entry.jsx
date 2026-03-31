import React from "react";
import { createRoot } from "react-dom/client";
import DashboardApp from "./App.jsx";

const root = createRoot(document.getElementById("app"));
root.render(<DashboardApp />);
