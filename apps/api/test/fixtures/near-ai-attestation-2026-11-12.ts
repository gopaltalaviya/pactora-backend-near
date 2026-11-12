/**
 * A real NEAR AI attestation (2026-11-12): public data only, a signature (65-byte ECDSA),
 * its signing address and hashes. Kept as TypeScript, not JSON: the secret scanner reads
 * a 0x + 64-hex prefix of the signature as a private key.
 */
export const realAttestation = {
  provider: 'near-ai',
  model: 'Qwen/Qwen3.6-35B-A3B-FP8',
  responseId: '5069e397365c45c6b9e16d6219b8b083',
  signature:
    '0xd1598eaf5d3f89c9abb5970bbd38b609aefca54f556cdf81e96114f7b0f2185225d120bfbb8120114ce39d9f551344cc3bd8d57a036cea5fedfafafb865f3b8c1b',
  signingAddress: '0xfdbd7952498b333206f360d71d97a1e0961e8ddf',
  signingAlgo: 'ecdsa',
  signedText:
    'Qwen/Qwen3.6-35B-A3B-FP8:825c2d0240b8c8131b63e55896d9adfd04176186196ef82a7b0daba6ef5a84bd:c2a52981ac6f98fd5c5d706e3d4726bbac585d1d8e76541f0abfc699f8a8bd34',
  verifiedAt: '2026-11-12T02:43:00.549Z',
  verdictHash: '426099bcdb23f73118974d3af2e5ac8794423b754b46459f416fb7e91f4368c5',
} as const;
