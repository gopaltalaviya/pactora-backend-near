import {createHmac, timingSafeEqual} from 'node:crypto';

/**
 * The webhook signature (docs/15): `Pactora-Signature: t=<unix s>,v1=<hex>`
 * with v1 = HMAC-SHA256(secret, `${t}.${deliveryId}.${body}`). The delivery
 * id is inside the MAC, so a body cannot be replayed under another id, and
 * `t` lets a receiver refuse an old one.
 */
export function webhookSignature(secret: string, t: number, deliveryId: string, body: string): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${deliveryId}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** The receiver's side: true only for a matching MAC no older (or newer) than `toleranceS`. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  deliveryId: string,
  body: string,
  opts: {nowS?: number; toleranceS?: number} = {},
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const given = parts['v1'];
  if (!Number.isInteger(t) || typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? 300)) return false;
  const expected = webhookSignature(secret, t, deliveryId, body).split('v1=')[1]!;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}
