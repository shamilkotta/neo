import { type BlobKey, type BlobStore, rechunk } from "@neo/kernel";

const PART = 5 * 1024 * 1024;

export class CloudflareBlobs implements BlobStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
  ) {}

  private name(key: BlobKey) {
    return `${this.prefix}/${key}`;
  }

  async put(key: BlobKey, body: ReadableStream<Uint8Array>) {
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

  async get(key: BlobKey, range?: { offset: number; length: number }) {
    if (range?.length === 0) return new Blob([]).stream();
    const object = await this.bucket.get(
      this.name(key),
      range ? { range: { offset: range.offset, length: range.length } } : {},
    );
    return object?.body ?? null;
  }

  async delete(key: BlobKey) {
    await this.bucket.delete(this.name(key));
  }

  async clear() {
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
