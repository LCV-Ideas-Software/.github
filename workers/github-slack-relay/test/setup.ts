import { timingSafeEqual } from "node:crypto";

const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
};

if (typeof subtle.timingSafeEqual !== "function") {
  Object.defineProperty(subtle, "timingSafeEqual", {
    configurable: true,
    value(left: BufferSource, right: BufferSource): boolean {
      const leftBytes =
        left instanceof ArrayBuffer
          ? Buffer.from(left)
          : Buffer.from(left.buffer, left.byteOffset, left.byteLength);
      const rightBytes =
        right instanceof ArrayBuffer
          ? Buffer.from(right)
          : Buffer.from(right.buffer, right.byteOffset, right.byteLength);

      return (
        leftBytes.byteLength === rightBytes.byteLength &&
        timingSafeEqual(leftBytes, rightBytes)
      );
    },
  });
}
