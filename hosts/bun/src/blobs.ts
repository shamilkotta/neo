import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BlobStore, checkBlobKey } from "@neo/kernel";

/** The `blobs` port on Bun: large files as plain files under one folder: `<dir>/<first two of key>/<key>`. */
export class BunBlobs implements BlobStore {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    checkBlobKey(key);
    return join(this.dir, key.slice(0, 2), key);
  }

  async put(key: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written to a temporary name and renamed: a crash never leaves half an object under its key.
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, new Response(body));
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) return null;
    return (
      range ? file.slice(range.offset, range.offset + range.length) : file
    ).stream();
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
