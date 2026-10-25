import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { outDir: "../../dist", emptyOutDir: true, target: "es2022" },
});
