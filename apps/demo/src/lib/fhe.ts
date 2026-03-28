/**
 * FHE client-side helpers — Zama Relayer SDK wrapper
 *
 * Encryption:  client encrypts a uint64 with the network FHE public key.
 *              The resulting handle + inputProof are sent to the smart contract.
 *
 * Decryption:  user signs an EIP-712 authorization message via MetaMask.
 *              The Zama KMS gateway verifies the ACL, decrypts, and returns
 *              the plaintext — the private key never leaves the KMS.
 *
 * Only Sepolia is supported for real FHE right now, because that is where
 * the Zama KMS gateway and ACL contracts are deployed.
 */

import { pad, toHex, bytesToHex, isHex } from 'viem';
import type { Hex } from 'viem';

// ── Supported FHE networks ─────────────────────────────────────────────────

const FHE_SUPPORTED_CHAIN_IDS = new Set([11155111]); // Sepolia only for now

export function isFheSupported(chainId: number): boolean {
  return FHE_SUPPORTED_CHAIN_IDS.has(chainId);
}

// ── Singleton instance (one per tab, reset on chain change) ────────────────

let _instancePromise: Promise<unknown> | null = null;
let _instanceChainId: number | null = null;

/** Call this when MetaMask fires a chainChanged event to force re-init. */
export function resetFhevmInstance(): void {
  _instancePromise = null;
  _instanceChainId = null;
}

// ── Handle normalisation ───────────────────────────────────────────────────

/**
 * Normalize any handle format returned by the relayer SDK into a bytes32 hex
 * string, which is what AnomalyAgent.sol expects as `externalEuint64`.
 */
export function handleToHex32(handle: unknown): Hex {
  if (typeof handle === 'string') {
    const h = handle as Hex;
    if (!isHex(h)) throw new Error('handle string is not hex');
    return pad(h, { size: 32 });
  }
  if (typeof handle === 'bigint') return pad(toHex(handle), { size: 32 });
  if (typeof handle === 'number') return pad(toHex(BigInt(handle)), { size: 32 });
  if (handle instanceof Uint8Array) return pad(bytesToHex(handle), { size: 32 });
  if (handle instanceof ArrayBuffer) return pad(bytesToHex(new Uint8Array(handle)), { size: 32 });
  if (handle && typeof handle === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = handle as any;
    if (h.data instanceof Uint8Array) return pad(bytesToHex(h.data), { size: 32 });
    if (typeof h.hex === 'string')    return pad(h.hex as Hex, { size: 32 });
    if (typeof h.value === 'string')  return pad(h.value as Hex, { size: 32 });
    if (typeof h.toString === 'function') {
      const s: string = h.toString();
      if (s.startsWith('0x')) return pad(s as Hex, { size: 32 });
    }
  }
  throw new Error(`Unsupported handle type: ${typeof handle}`);
}

// ── SDK init ───────────────────────────────────────────────────────────────

async function getFhevmInstance(chainId: number) {
  if (typeof window === 'undefined') throw new Error('FHE can only be used in the browser.');
  if (!isFheSupported(chainId)) throw new Error(`FHE not supported on chain ${chainId}. Switch to Sepolia.`);

  // Return existing instance if same chain
  if (_instancePromise && _instanceChainId === chainId) return _instancePromise;

  _instanceChainId = chainId;
  _instancePromise = (async () => {
    // Dynamic import keeps the heavy WASM bundle out of the initial page load
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('@zama-fhe/relayer-sdk/bundle') as any;
    await mod.initSDK();
    return mod.createInstance({ ...mod.SepoliaConfig, network: window.ethereum });
  })();

  return _instancePromise;
}

// ── Encrypt ────────────────────────────────────────────────────────────────

/**
 * Encrypt a uint64 value client-side so it can be submitted to AnomalyAgent.
 * Returns the handle (ciphertext reference) and inputProof (ZK proof of
 * correct encryption) that the contract's `submitScore` expects.
 */
export async function encryptUint64(params: {
  chainId: number;
  contractAddress: `0x${string}`;
  userAddress: `0x${string}`;
  value: bigint;
}): Promise<{ handle: Hex; inputProof: Hex }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = await getFhevmInstance(params.chainId) as any;

  const buffer = instance.createEncryptedInput(params.contractAddress, params.userAddress);
  buffer.add64(params.value);
  const ciphertexts = await buffer.encrypt();

  const rawHandle = ciphertexts.handles?.[0];
  if (rawHandle === undefined) throw new Error('encrypt() returned no handles');
  const handle = handleToHex32(rawHandle);

  const rawProof = ciphertexts.inputProof;
  const inputProof: Hex =
    typeof rawProof === 'string'          ? (rawProof as Hex)
    : rawProof instanceof Uint8Array      ? bytesToHex(rawProof)
    : toHex(rawProof as Parameters<typeof toHex>[0]);

  if (!isHex(handle))     throw new Error(`Invalid handle: ${String(handle)}`);
  if (!isHex(inputProof)) throw new Error(`Invalid inputProof: ${String(inputProof)}`);

  return { handle, inputProof };
}

// ── Decrypt ────────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted score handle from AnomalyAgent using the Zama KMS gateway.
 *
 * The user must sign an EIP-712 message with MetaMask to authorize decryption.
 * The KMS checks the on-chain ACL (the contract must have called FHE.allow()
 * for this user's address) before returning the plaintext.
 *
 * @returns The decrypted uint64 value (the anomaly score).
 */
export async function decryptAnomalyScore(params: {
  chainId: number;
  userAddress: `0x${string}`;
  contractAddress: `0x${string}`;
  handle: Hex;
}): Promise<bigint> {
  if (!window.ethereum) throw new Error('MetaMask not found');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = await getFhevmInstance(params.chainId) as any;

  const keypair    = instance.generateKeypair();
  const startTs    = Math.floor(Date.now() / 1000);
  const durationD  = 10;
  const contracts  = [params.contractAddress];

  const eip712 = instance.createEIP712(keypair.publicKey, contracts, startTs, durationD);

  // Ask MetaMask to sign the EIP-712 authorization message
  const signature = await window.ethereum.request<string>({
    method: 'eth_signTypedData_v4',
    params: [
      params.userAddress,
      JSON.stringify({
        domain:      eip712.domain,
        types:       eip712.types,
        primaryType: 'UserDecryptRequestVerification',
        message:     eip712.message,
      }),
    ],
  });

  if (!signature) throw new Error('Signature rejected');
  const sigHex = (signature as string).replace('0x', '');

  const result = await instance.userDecrypt(
    [{ handle: params.handle, contractAddress: params.contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    sigHex,
    contracts,
    params.userAddress,
    startTs,
    durationD,
  );

  const value = result[params.handle];
  if (value === undefined || value === null) throw new Error('KMS returned no value for handle');
  return BigInt(value);
}
