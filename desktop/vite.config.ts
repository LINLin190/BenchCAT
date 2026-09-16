import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const bridgePort = 1421;

function browserBridgePlugin() {
  let child: ChildProcess | undefined;
  const stop = () => {
    if (child && child.exitCode === null) child.kill();
    child = undefined;
  };
  return {
    name: "ethercat-browser-bridge",
    configureServer(server: { httpServer?: { once: (event: string, listener: () => void) => void } | null }) {
      const python = process.env.ETHERCAT_WORKBENCH_PYTHON || "python";
      const pythonPath = [resolve(repositoryRoot, "src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(delimiter);
      child = spawn(
        python,
        ["-u", "-m", "ethercat_debug_tool.web_bridge", "--host", "127.0.0.1", "--port", String(bridgePort)],
        {
          cwd: repositoryRoot,
          env: { ...process.env, PYTHONPATH: pythonPath },
          stdio: ["ignore", "inherit", "inherit"],
          windowsHide: true,
        },
      );
      child.once("exit", (code) => {
        if (code && code !== 0) console.error(`EtherCAT browser bridge exited with code ${code}`);
      });
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "browser" ? [browserBridgePlugin()] : [])],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
    proxy: mode === "browser" ? {
      "/api": {
        target: `http://127.0.0.1:${bridgePort}`,
        timeout: 950_000,
        proxyTimeout: 950_000,
      },
    } : undefined,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@mui/icons-material")) return "mui-icons";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
}));
