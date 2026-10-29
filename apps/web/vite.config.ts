import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { deployedSiteUrl } from "./deployment";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": deployedSiteUrl,
    },
  },
});
