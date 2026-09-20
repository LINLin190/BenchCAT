import { check } from "@tauri-apps/plugin-updater";

export interface UpdateProgress {
  phase: "downloading" | "installing";
  downloaded: number;
  total?: number;
}

export interface AvailableUpdate {
  version: string;
  notes?: string;
  date?: string;
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  close(): Promise<void>;
}

const isTauri = "__TAURI_INTERNALS__" in window;

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri) return null;
  const update = await check({ timeout: 15_000 });
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body,
    date: update.date,
    close: () => update.close(),
    downloadAndInstall: async (onProgress) => {
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? undefined;
          onProgress({ phase: "downloading", downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress({ phase: "downloading", downloaded, total });
        } else if (event.event === "Finished") {
          onProgress({ phase: "installing", downloaded, total: total ?? downloaded });
        }
      }, { timeout: 15 * 60_000, restartAfterInstall: true });
    },
  };
}
