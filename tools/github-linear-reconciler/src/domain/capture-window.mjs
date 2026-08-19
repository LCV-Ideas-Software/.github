function instantMs(value, label) {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError(`${label} inválido`);
  }
  return milliseconds;
}

export function createCaptureWindow({ startedAt, clock } = {}) {
  const captureStartedAtMs = instantMs(startedAt, "início da captura");
  if (clock !== undefined && typeof clock !== "function") {
    throw new TypeError("relógio da captura inválido");
  }
  let ceilingMs = captureStartedAtMs;
  let closed = false;

  function advance() {
    if (closed || clock === undefined) return ceilingMs;
    const candidateMs = instantMs(clock(), "relógio da captura");
    if (candidateMs < ceilingMs) {
      throw new RangeError("relógio da captura regressivo");
    }
    ceilingMs = candidateMs;
    return ceilingMs;
  }

  return Object.freeze({
    captureStartedAtMs,
    lastCeilingMs() {
      return ceilingMs;
    },
    currentCeilingMs: advance,
    closeMs() {
      const finalMs = advance();
      closed = true;
      return finalMs;
    },
  });
}
