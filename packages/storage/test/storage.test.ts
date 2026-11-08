import {describe, expect, it} from 'vitest';
import type {S3Client} from '@aws-sdk/client-s3';
import {MemoryObjectStore, S3ObjectStore, type ObjectStore} from '../src/index.js';

/**
 * The object store contract (docs/26 F6), run against the in-memory fake
 * and against the S3 adapter with a recorded client — what the adapter
 * sends is what S3 (and MinIO) is asked to do. The live MinIO check is in
 * the demo, which uploads through the real adapter.
 */

type Sent = {name: string; input: Record<string, unknown>};

/** An S3Client stand-in that keeps objects in a map and records every command. */
function recordingClient(): {client: S3Client; sent: Sent[]; buckets: Set<string>} {
  const objects = new Map<string, {body: Uint8Array; type: string}>();
  const buckets = new Set<string>();
  const sent: Sent[] = [];
  const missing = (name: string) => Object.assign(new Error(name), {name, $metadata: {httpStatusCode: 404}});
  const client = {
    async send(command: {constructor: {name: string}; input: Record<string, unknown>}) {
      const name = command.constructor.name;
      const input = command.input;
      sent.push({name, input});
      const key = `${String(input['Bucket'])}/${String(input['Key'])}`;
      switch (name) {
        case 'PutObjectCommand':
          objects.set(key, {
            body: new Uint8Array(input['Body'] as Uint8Array),
            type: String(input['ContentType']),
          });
          return {};
        case 'GetObjectCommand': {
          const o = objects.get(key);
          if (!o) throw missing('NoSuchKey');
          return {Body: {transformToByteArray: async () => o.body}};
        }
        case 'HeadObjectCommand': {
          const o = objects.get(key);
          if (!o) throw missing('NotFound');
          return {ContentLength: o.body.length, ContentType: o.type};
        }
        case 'DeleteObjectCommand':
          objects.delete(key);
          return {};
        case 'HeadBucketCommand':
          if (!buckets.has(String(input['Bucket']))) throw missing('NotFound');
          return {};
        case 'CreateBucketCommand':
          buckets.add(String(input['Bucket']));
          return {};
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  } as unknown as S3Client;
  return {client, sent, buckets};
}

async function contract(store: ObjectStore) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await store.put('evidence/a.png', bytes, 'image/png');
  bytes[0] = 9; // the store must not alias the caller's buffer
  expect(Array.from((await store.get('evidence/a.png'))!)).toEqual([1, 2, 3, 4]);
  expect(await store.head('evidence/a.png')).toEqual({size: 4, contentType: 'image/png'});
  expect(await store.get('evidence/none.png')).toBeNull();
  expect(await store.head('evidence/none.png')).toBeNull();
  await store.delete('evidence/a.png');
  await store.delete('evidence/a.png'); // twice is not an error
  expect(await store.get('evidence/a.png')).toBeNull();
}

describe('ObjectStore', () => {
  it('the in-memory fake keeps the contract', async () => {
    await contract(new MemoryObjectStore());
  });

  it('the S3 adapter keeps the contract', async () => {
    const {client} = recordingClient();
    await contract(new S3ObjectStore({bucket: 'b', region: 'us-east-1', client}));
  });

  it('writes every object with server-side encryption, its type and length, into the bucket', async () => {
    const {client, sent} = recordingClient();
    await new S3ObjectStore({bucket: 'evidence', region: 'eu-central-1', client}).put(
      'k',
      new Uint8Array(3),
      'image/webp',
    );
    expect(sent[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'evidence',
        Key: 'k',
        ContentType: 'image/webp',
        ContentLength: 3,
        ServerSideEncryption: 'AES256',
      },
    });
    const kms = recordingClient();
    await new S3ObjectStore({
      bucket: 'e',
      region: 'r',
      client: kms.client,
      serverSideEncryption: 'aws:kms',
    }).put('k', new Uint8Array(1), 'image/png');
    expect(kms.sent[0]!.input['ServerSideEncryption']).toBe('aws:kms');
    const none = recordingClient();
    await new S3ObjectStore({
      bucket: 'e',
      region: 'r',
      client: none.client,
      serverSideEncryption: 'none',
    }).put('k', new Uint8Array(1), 'image/png');
    expect(none.sent[0]!.input).not.toHaveProperty('ServerSideEncryption');
  });

  it('creates a missing bucket only when asked to (a local MinIO), and otherwise says it is missing', async () => {
    const {client, buckets} = recordingClient();
    const store = new S3ObjectStore({bucket: 'evidence', region: 'r', client});
    await expect(store.ensureBucket(false)).rejects.toThrow(/NotFound/);
    await store.ensureBucket(true);
    expect(buckets.has('evidence')).toBe(true);
    await store.ensureBucket(false);
  });

  it('passes a real failure through rather than reading it as "missing"', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('AccessDenied'), {
          name: 'AccessDenied',
          $metadata: {httpStatusCode: 403},
        });
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore({bucket: 'b', region: 'r', client});
    await expect(store.get('k')).rejects.toThrow(/AccessDenied/);
    await expect(store.head('k')).rejects.toThrow(/AccessDenied/);
    await expect(store.ensureBucket(true)).rejects.toThrow(/AccessDenied/);
  });

  it('builds its own client from endpoint, region, credentials and path style', () => {
    const store = new S3ObjectStore({
      bucket: 'b',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9110',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });
    const config = (store as unknown as {client: S3Client}).client.config;
    expect(config.forcePathStyle).toBe(true);
  });
});
