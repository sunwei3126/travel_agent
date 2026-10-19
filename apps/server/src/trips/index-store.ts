import { readFile, rename, writeFile } from "node:fs/promises";
import type { TripIndexEntry } from "@pi-demo/shared";

export class TripIndexStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<TripIndexEntry[]> {
    const entries = await this.read();
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(tripId: string): Promise<TripIndexEntry | undefined> {
    return (await this.read()).find((entry) => entry.tripId === tripId);
  }

  async upsert(entry: TripIndexEntry): Promise<void> {
    const entries = await this.read();
    const index = entries.findIndex((existing) => existing.tripId === entry.tripId);
    if (index === -1) {
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  private async read(): Promise<TripIndexEntry[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as TripIndexEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
