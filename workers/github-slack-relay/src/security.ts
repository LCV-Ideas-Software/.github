interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) {
      return null;
    }
    bytes[index / 2] = byte;
  }

  return bytes;
}

export async function readSecret(binding: unknown): Promise<string> {
  if (typeof binding === "string") {
    return binding;
  }

  if (
    binding === null ||
    typeof binding !== "object" ||
    !("get" in binding) ||
    typeof binding.get !== "function"
  ) {
    throw new Error("secret_binding_unavailable");
  }

  const value = await binding.get();
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("secret_value_unavailable");
  }

  return value;
}

export async function verifyGitHubSignature(
  body: ArrayBuffer,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(signatureHeader);
  if (match === null || match[1] === undefined || secret.length === 0) {
    return false;
  }

  const received = decodeHex(match[1]);
  if (received === null) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const calculated = new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, body),
  );
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;

  if (typeof subtle.timingSafeEqual !== "function") {
    throw new Error("timing_safe_comparison_unavailable");
  }

  return subtle.timingSafeEqual(calculated, received);
}
