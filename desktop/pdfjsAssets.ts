import type { Plugin } from "vite";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];

/** Bundle the same offline decoding assets served by the development server. */
export function pdfjsAssets(): Plugin {
  return {
    name: "benchcat-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec(path);
        if (!match) return next();
        const file = join(pdfRoot, match[1], match[2]);
        try {
          response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
          response.setHeader("Content-Length", statSync(file).size);
          createReadStream(file).pipe(response);
        } catch { next(); }
      });
    },
    generateBundle() {
      for (const directory of directories) {
        for (const name of readdirSync(join(pdfRoot, directory))) {
          const file = join(pdfRoot, directory, name);
          if (!statSync(file).isFile()) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${relative(pdfRoot, file).replaceAll("\\", "/")}`, source: readFileSync(file) });
        }
      }
      this.emitFile({ type: "asset", fileName: "pdfjs/LICENSE", source: readFileSync(join(pdfRoot, "LICENSE")) });
    },
  };
}
