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

import { toHex, bytesToHex, isHex } from 'viem';
import type { Hex } from 'viem';

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
      on(event: string, handler: (...args: unknown[]) => void): void;
      removeListener(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

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

function asHex(handle: unknown): Hex {
  if (typeof handle === 'string') {
    if (!isHex(handle)) throw new Error('handle string is not hex');
    return handle as Hex;
  }
  if (typeof handle === 'bigint') return toHex(handle);
  if (typeof handle === 'number') return toHex(BigInt(handle));
  if (handle instanceof Uint8Array) return bytesToHex(handle);
  if (handle instanceof ArrayBuffer) return bytesToHex(new Uint8Array(handle));

  if (handle && typeof handle === 'object') {
    const h = handle as {
      data?: Uint8Array;
      hex?: string;
      value?: string;
      toString?: () => string;
    };

    if (h.data instanceof Uint8Array) return bytesToHex(h.data);
    if (typeof h.hex === 'string' && isHex(h.hex)) return h.hex as Hex;
    if (typeof h.value === 'string' && isHex(h.value)) return h.value as Hex;

    if (typeof h.toString === 'function') {
      const s = h.toString();
      if (isHex(s)) return s as Hex;
    }
  }

  throw new Error(`Unsupported handle type: ${typeof handle}`);
}

function hexByteLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}

/**
 * Normalize any handle format returned by the relayer SDK into a bytes32 hex
 * string, which is what AnomalyAgent.sol expects as `externalEuint64`.
 */
export function handleToHex32(handle: unknown): Hex {
  const hex = asHex(handle);
  const len = hexByteLength(hex);

  if (len === 32) return hex;

  // Temporary compatibility shim: a 33-byte handle with an extra trailing 00.
  if (len === 33 && hex.endsWith('00')) {
    return `0x${hex.slice(2, -2)}` as Hex;
  }

  throw new Error(`Expected 32-byte externalEuint64 handle, got ${len} bytes: ${hex}`);
}

// ── SDK init ───────────────────────────────────────────────────────────────

const RELAYER_SDK_VERSION = '0.4.2';

/**
 * Injects the Zama Relayer SDK UMD bundle as a <script> tag (once) and waits
 * for it to execute. Accepts a custom endpoint so the plugin works in any
 * Next.js app regardless of route layout.
 */
function loadRelayerSdkScript(endpoint = '/api/relayer-sdk'): Promise<void> {
  const scriptSrc = `${endpoint}?v=${RELAYER_SDK_VERSION}`;

  const existing = document.getElementById('zama-relayer-sdk') as HTMLScriptElement | null;
  if (existing && existing.dataset.sdkVersion !== RELAYER_SDK_VERSION) {
    existing.remove();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).relayerSDK = undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).relayerSDK) return Promise.resolve();

  if (document.getElementById('zama-relayer-sdk')) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).relayerSDK) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); reject(new Error('Zama SDK load timeout')); }, 30_000);
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id                 = 'zama-relayer-sdk';
    script.dataset.sdkVersion = RELAYER_SDK_VERSION;
    script.src                = scriptSrc;
    script.onload             = () => resolve();
    script.onerror            = () => reject(new Error(`Failed to load Zama Relayer SDK from ${scriptSrc}`));
    document.head.appendChild(script);
  });
}

async function getFhevmInstance(chainId: number, relayerSdkEndpoint?: string) {
  if (typeof window === 'undefined') throw new Error('FHE can only be used in the browser.');
  if (!isFheSupported(chainId)) throw new Error(`FHE not supported on chain ${chainId}. Switch to Sepolia.`);

  if (_instancePromise && _instanceChainId === chainId) return _instancePromise;

  _instanceChainId = chainId;
  _instancePromise = (async () => {
    await loadRelayerSdkScript(relayerSdkEndpoint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = (window as any).relayerSDK;
    if (!sdk) throw new Error('window.relayerSDK not defined after script load');
    await sdk.initSDK();
    return sdk.createInstance({ ...sdk.SepoliaConfig, network: window.ethereum });
  })().catch((err) => {
    _instancePromise = null;
    _instanceChainId = null;
    throw err;
  });

  return _instancePromise;
}

// ── Encrypt ────────────────────────────────────────────────────────────────

export async function encryptUint64(params: {
  chainId: number;
  contractAddress: `0x${string}`;
  userAddress: `0x${string}`;
  value: bigint;
  relayerSdkEndpoint?: string;
}): Promise<{ handle: Hex; inputProof: Hex }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = await getFhevmInstance(params.chainId, params.relayerSdkEndpoint) as any;

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

export async function decryptAnomalyScore(params: {
  chainId: number;
  userAddress: `0x${string}`;
  contractAddress: `0x${string}`;
  handle: Hex;
  relayerSdkEndpoint?: string;
}): Promise<bigint> {
  if (!window.ethereum) throw new Error('MetaMask not found');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = await getFhevmInstance(params.chainId, params.relayerSdkEndpoint) as any;

  const keypair   = instance.generateKeypair();
  const startTs   = Math.floor(Date.now() / 1000);
  const durationD = 10;
  const contracts = [params.contractAddress];

  const eip712 = instance.createEIP712(keypair.publicKey, contracts, startTs, durationD);

  const eip712Json = JSON.stringify(
    {
      domain:      eip712.domain,
      types:       eip712.types,
      primaryType: 'UserDecryptRequestVerification',
      message:     eip712.message,
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  );

  const signature = await window.ethereum.request<string>({
    method: 'eth_signTypedData_v4',
    params: [params.userAddress, eip712Json],
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
