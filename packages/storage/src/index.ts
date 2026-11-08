import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';

/**
 * Where evidence files live (docs/26 F6): private, S3-compatible object
 * storage with server-side encryption — never the API host's disk, which has
 * no replication and is gone with the container.
 *
 * Four operations and nothing else, so the routes cannot come to depend on
 * one vendor's extras, and a test can stand in an in-memory store that
 * behaves the same way.
 */
export interface ObjectStore {
  /** Store `bytes` under `key`, replacing anything there. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes under `key`, or null if there are none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove `key`. Removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Size and type of `key`, or null if there is nothing there. */
  head(key: string): Promise<{size: number; contentType: string} | null>;
}

/** For tests (and only tests): the same contract, held in a Map. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, {bytes: Uint8Array; contentType: string}>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // A copy: the caller's buffer may be reused, and a store never aliases it.
    this.objects.set(key, {bytes: new Uint8Array(bytes), contentType});
  }

  async get(key: string): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    return o ? new Uint8Array(o.bytes) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async head(key: string): Promise<{size: number; contentType: string} | null> {
    const o = this.objects.get(key);
    return o ? {size: o.bytes.byteLength, contentType: o.contentType} : null;
  }
}

export interface S3StoreOptions {
  bucket: string;
  region: string;
  /** An S3-compatible endpoint (MinIO locally); omitted, AWS itself. */
  endpoint?: string;
  /** Explicit credentials; omitted, the AWS SDK's default chain (an instance role). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** `bucket` in the path rather than the host name — what MinIO serves. */
  forcePathStyle?: boolean;
  /** The encryption every object is written with; `none` only where the store cannot (documented). */
  serverSideEncryption?: 'AES256' | 'aws:kms' | 'none';
  /** For tests: a client to use instead of building one. */
  client?: S3Client;
}

/** True for the SDK's "there is nothing there" answers, whatever the store calls them. */
function isMissing(err: unknown): boolean {
  const e = err as {name?: string; $metadata?: {httpStatusCode?: number}};
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly sse: ServerSideEncryption | undefined;

  constructor(opts: S3StoreOptions) {
    this.bucket = opts.bucket;
    this.sse =
      (opts.serverSideEncryption ?? 'AES256') === 'none'
        ? undefined
        : ((opts.serverSideEncryption ?? 'AES256') as ServerSideEncryption);
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region,
        ...(opts.endpoint ? {endpoint: opts.endpoint} : {}),
        forcePathStyle: opts.forcePathStyle ?? false,
        ...(opts.accessKeyId && opts.secretAccessKey
          ? {credentials: {accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey}}
          : {}),
        // Checksums only where S3 requires them: S3-compatible stores lag
        // behind the SDK's newer default checksum headers.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 3,
      });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.byteLength,
        ...(this.sse ? {ServerSideEncryption: this.sse} : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({Bucket: this.bucket, Key: key}));
      if (!out.Body) return null;
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({Bucket: this.bucket, Key: key}));
  }

  async head(key: string): Promise<{size: number; contentType: string} | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({Bucket: this.bucket, Key: key}));
      return {
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * Is the bucket there? `create` makes it when it is not — for a local
   * MinIO only; a deployment's bucket is made, with its policy, by whoever
   * runs the deployment, never by the API.
   */
  async ensureBucket(create: boolean): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({Bucket: this.bucket}));
    } catch (err) {
      if (!create || !isMissing(err)) throw err;
      await this.client.send(new CreateBucketCommand({Bucket: this.bucket}));
    }
  }
}
