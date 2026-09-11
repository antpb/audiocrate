var performance =
  typeof globalThis !== 'undefined' && globalThis.performance && typeof globalThis.performance.now === 'function'
    ? globalThis.performance
    : { now: function () { return 0; } };
