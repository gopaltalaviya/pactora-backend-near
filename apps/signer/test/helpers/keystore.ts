import {createCipheriv, pbkdf2Sync, randomBytes} from 'node:crypto';
import {keccak256} from 'viem';

/**
 * A Web3 Secret Storage v3 keystore, made the way geth and `cast` make one
 * (pbkdf2-sha256, aes-128-ctr, keccak MAC) — with 2 iterations, because a
 * test has no attacker to slow down.
 */
export function makeKeystore(privateKey: `0x${string}`, passphrase: string) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 2, 32, 'sha256');
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()]);
  const mac = keccak256(`0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString('hex')}`).slice(
    2,
  );
  return {
    version: 3 as const,
    crypto: {
      cipher: 'aes-128-ctr',
      ciphertext: ciphertext.toString('hex'),
      cipherparams: {iv: iv.toString('hex')},
      kdf: 'pbkdf2' as const,
      kdfparams: {salt: salt.toString('hex'), c: 2, dklen: 32, prf: 'hmac-sha256'},
      mac,
    },
  };
}
