import {z} from 'zod';

/**
 * Opaque page cursors (v3).
 *
 * A cursor wraps the internal row id the list is ordered by. Opaque so a
 * client treats it as a token rather than doing arithmetic on it, and so the
 * scheme can change; NOT secret — every list is already scoped to the caller.
 * A cursor that does not decode is a validation failure (422), never a guess.
 */
const PREFIX = 'v1:';

export function encodeCursor(id: number): string {
  return Buffer.from(`${PREFIX}${id}`, 'utf8').toString('base64url');
}

/** `?cursor=` as a schema: decodes to the row id, or fails validation. */
export const Cursor = z.string().transform((raw, ctx) => {
  const text = /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? Buffer.from(raw, 'base64url').toString('utf8') : '';
  const m = /^v1:([1-9]\d{0,15})$/.exec(text);
  if (!m) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'not a cursor this API issued'});
    return z.NEVER;
  }
  return Number(m[1]);
});

/**
 * Trim the extra row a list fetched to learn whether another page exists.
 * Lists ask for `limit + 1`; if they got it, there is a next page, starting
 * after the last row actually returned.
 */
export function page<T extends {id: number}>(
  rows: T[],
  limit: number,
): {rows: T[]; nextCursor: string | null} {
  if (rows.length <= limit) return {rows, nextCursor: null};
  const kept = rows.slice(0, limit);
  return {rows: kept, nextCursor: encodeCursor(kept[kept.length - 1]!.id)};
}
