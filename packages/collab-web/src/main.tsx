import { initializeI18n } from "@oh-my-pi/pi-utils/i18n-browser";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";

// UI modules capture labels at import time, so the host's pack must be ready first.
void initializeI18n().then(async () => {
	const { App } = await import("./app");
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root element");
	createRoot(root).render(<App />);
});
