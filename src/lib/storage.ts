import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MAX_RESUME_BYTES } from "@/lib/constants";
import { sniffResumeType } from "@/lib/file-type";

/**
 * Resume file storage. Two drivers behind one interface:
 *   STORAGE_DRIVER=local  files on disk (dev, or a single self-hosted server)
 *   STORAGE_DRIVER=s3     any S3-compatible bucket (Cloudflare R2, Backblaze
 *                         B2, MinIO, AWS S3, ...)
 */
interface Driver {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

// ---- local disk -----------------------------------------------------------

function localDriver(): Driver {
  const root = path.resolve(
    /*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? "./data/uploads",
  );
  const resolveKey = (key: string) => {
    const full = path.resolve(/*turbopackIgnore: true*/ root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage key");
    return full;
  };
  return {
    async put(key, data) {
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data);
    },
    async get(key) {
      return readFile(resolveKey(key));
    },
    async remove(key) {
      await unlink(resolveKey(key)).catch(() => {});
    },
  };
}

// ---- S3-compatible --------------------------------------------------------

function s3Driver(): Driver {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
    );
  }
  const prefix = (process.env.S3_KEY_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const fullKey = (key: string) => (prefix ? `${prefix}/${key}` : key);

  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId, secretAccessKey },
    // Newer SDK versions add checksum headers that many S3-compatible
    // services (R2, B2, MinIO) don't support; only send them when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    async put(key, data, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: data,
          ContentType: contentType,
        }),
      );
    },
    async get(key) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }),
      );
      if (!res.Body) throw new Error("Empty object body");
      return Buffer.from(await res.Body.transformToByteArray());
    },
    async remove(key) {
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(key) }))
        .catch(() => {});
    },
  };
}

let cached: Driver | undefined;
function driver(): Driver {
  if (!cached) {
    const name = process.env.STORAGE_DRIVER ?? "local";
    if (name === "s3") cached = s3Driver();
    else if (name === "local") cached = localDriver();
    else throw new Error(`Unknown STORAGE_DRIVER "${name}" (use "local" or "s3")`);
  }
  return cached;
}

/** Test hook: forget the cached driver after changing env vars. */
export function resetStorageDriver() {
  cached = undefined;
}

// ---- resume uploads -------------------------------------------------------

export type ResumeUpload = {
  fileName: string;
  /** Detected from the file's contents, not the browser's claim. */
  mimeType: string;
  size: number;
  buffer: Buffer;
};

export type ResumeUploadResult =
  | { ok: true; upload: ResumeUpload }
  | { ok: false; error: string };

function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "resume").slice(0, 200);
}

/** Validates an uploaded form file and reads it into memory. */
export async function readResumeUpload(
  value: FormDataEntryValue | null,
): Promise<ResumeUploadResult> {
  if (!(value instanceof File) || value.size === 0) {
    return { ok: false, error: "Choose a file to upload" };
  }
  if (value.size > MAX_RESUME_BYTES) {
    return {
      ok: false,
      error: `File is too large (max ${MAX_RESUME_BYTES / 1024 / 1024} MB)`,
    };
  }
  const buffer = Buffer.from(await value.arrayBuffer());
  const mimeType = sniffResumeType(buffer);
  if (!mimeType) {
    return { ok: false, error: "Upload a PDF, DOC, or DOCX file" };
  }
  return {
    ok: true,
    upload: {
      fileName: safeFileName(value.name),
      mimeType,
      size: buffer.length,
      buffer,
    },
  };
}

export async function saveResumeFile(userId: string, upload: ResumeUpload) {
  const storageKey = `${userId}/${randomUUID()}`;
  await driver().put(storageKey, upload.buffer, upload.mimeType);
  return storageKey;
}

// async so a misconfigured driver or bad key surfaces as a rejected promise,
// which callers' .catch() handlers can actually catch.
export async function readResumeFile(storageKey: string) {
  return driver().get(storageKey);
}

export async function deleteResumeFile(storageKey: string) {
  return driver().remove(storageKey);
}
