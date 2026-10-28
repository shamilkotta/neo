import { type BlobStore, checkBlobKey, rechunk } from "@neo/kernel";

// R2 multipart parts must all be the same size (except the last), and at least 5 MiB.
const PART = 5 * 1024 * 1024;

/**
 * The `blobs` port on Cloudflare: large files in R2, under this Durable Object's own prefix (one bucket serves every instance).
 * A stream of unknown length goes up as a multipart upload, a part at a time, so memory stays at
 * about two parts; an object that fits in one part is a single put.
 */
export class CloudflareBlobs implements BlobStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
  ) {}

  private name(key: string): string {
    checkBlobKey(key);
    return `${this.prefix}/${key}`;
  }

  async put(key: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const name = this.name(key);
    let upload: R2MultipartUpload | undefined;
    const parts: R2UploadedPart[] = [];
    let held: Uint8Array | undefined;
    try {
      for await (const part of rechunk(body, PART)) {
        if (!upload && held === undefined) {
          held = part;
          continue;
        }
        upload ??= await this.bucket.createMultipartUpload(name);
        if (held) {
          parts.push(await upload.uploadPart(1, held));
          held = undefined;
        }
        parts.push(await upload.uploadPart(parts.length + 1, part));
      }
      if (upload) await upload.complete(parts);
      else await this.bucket.put(name, held ?? new Uint8Array());
    } catch (error) {
      await upload?.abort().catch(() => {});
      throw error;
    }
  }

  async get(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (range?.length === 0) return new Blob([]).stream();
    const object = await this.bucket.get(
      this.name(key),
      range ? { range: { offset: range.offset, length: range.length } } : {},
    );
    return object?.body ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(this.name(key));
  }

  async clear(): Promise<void> {
    for (let cursor: string | undefined; ;) {
      const page = await this.bucket.list({
        prefix: `${this.prefix}/`,
        ...(cursor ? { cursor } : {}),
      });
      if (page.objects.length)
        await this.bucket.delete(page.objects.map((o) => o.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }
}
