import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateProgress {
  downloaded: number;
  total?: number;
}

export interface AvailableUpdate {
  version: string;
  notes?: string;
  date?: string;
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>;
}

const isTauri = "__TAURI_INTERNALS__" in window;

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri) return null;
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body,
    date: update.date,
    downloadAndInstall: async (onProgress) => {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          onProgress({ downloaded: 0, total: event.data.contentLength ?? undefined });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress({ downloaded, total: undefined });
        } else if (event.event === "Finished") {
          onProgress({ downloaded, total: downloaded });
        }
      }, { restartAfterInstall: true });
    },
  };
}

export async function restartAfterUpdate(): Promise<void> {
  if (isTauri) await relaunch();
}
