export type ServerSentEvent = {
  data: string;
  event: string;
  id: string;
  retry: number | null;
};

/**
 * Incremental parser for the event-stream wire format.
 *
 * It accepts arbitrary byte boundaries, including boundaries inside UTF-8
 * sequences, field names, CRLF pairs, and JSON payloads.
 */
export class ServerSentEventParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private lastEventId = "";
  private retry: number | null = null;
  private sawData = false;
  private discardedLeadingBom = false;

  constructor(private readonly onEvent: (event: ServerSentEvent) => void) {}

  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.processCompleteLines();
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.processCompleteLines();

    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
    this.dispatch();
  }

  /**
   * Walks the buffer with an offset and trims it once: slicing after every
   * line copies the rest of the buffer each time, which is quadratic when a
   * whole stored stream is pushed at once.
   */
  private processCompleteLines() {
    let start = 0;
    // The next "\r" at or after `start`; -1 once there are none left.
    let carriageReturn = this.buffer.indexOf("\r");
    while (true) {
      if (carriageReturn !== -1 && carriageReturn < start) {
        carriageReturn = this.buffer.indexOf("\r", start);
      }
      const lineFeed = this.buffer.indexOf("\n", start);
      const candidates = [lineFeed, carriageReturn].filter(
        (position) => position >= 0,
      );
      if (candidates.length === 0) break;

      const lineEnd = Math.min(...candidates);
      const terminator = this.buffer[lineEnd];
      if (
        terminator === "\r" &&
        lineEnd === this.buffer.length - 1
      ) {
        // CRLF may be split across chunks. Wait for one more byte.
        break;
      }

      const line = this.buffer.slice(start, lineEnd);
      const terminatorLength =
        terminator === "\r" && this.buffer[lineEnd + 1] === "\n" ? 2 : 1;
      start = lineEnd + terminatorLength;
      this.processLine(line);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
  }

  private processLine(rawLine: string) {
    let line = rawLine;
    if (!this.discardedLeadingBom) {
      this.discardedLeadingBom = true;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }

    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.data.push(value);
        this.sawData = true;
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
  }

  private dispatch() {
    if (!this.sawData) {
      this.event = "";
      this.retry = null;
      return;
    }

    this.onEvent({
      data: this.data.join("\n"),
      event: this.event || "message",
      id: this.lastEventId,
      retry: this.retry,
    });
    this.data = [];
    this.event = "";
    this.retry = null;
    this.sawData = false;
  }
}
