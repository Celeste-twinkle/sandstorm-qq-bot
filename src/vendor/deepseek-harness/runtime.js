// Bot adapter for the Harness error/deadline seams. See VENDOR-NOTES.md.
class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "WebError";
    this.code = code;
  }
}

class DeadlineReason extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function deadline(parent, timeoutMs, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineReason(code)), timeoutMs);
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose() { clearTimeout(timer); },
  };
}

function timeoutOf(signal, code) {
  return signal.aborted && signal.reason instanceof DeadlineReason && signal.reason.code === code
    ? signal.reason : undefined;
}

module.exports = { WebError, deadline, timeoutOf };
