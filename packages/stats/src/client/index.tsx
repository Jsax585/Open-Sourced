import { initializeI18n } from "@oh-my-pi/pi-utils/i18n-browser";
import "./styles.css";
import { createRoot } from "react-dom/client";

// Navigation labels are initialized by the application import.
void initializeI18n().then(async () => {
	const { default: App } = await import("./App");
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root");
	createRoot(root).render(<App />);
});
