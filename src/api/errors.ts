/** Errors raised by the ProAbono API Live, carried with the code the API returned. */
export class ProAbonoApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly target: string | undefined;

  constructor(status: number, code: string | undefined, message: string, target?: string) {
    super(message);
    this.name = "ProAbonoApiError";
    this.status = status;
    this.code = code;
    this.target = target;
  }

  /** What a tool shows the developer: the API's own wording, plus the code to search for. */
  describe(): string {
    const code = this.code ? ` [${this.code}]` : "";
    const target = this.target ? ` (field: ${this.target})` : "";
    return `ProAbono API error ${this.status}${code}: ${this.message}${target}`;
  }
}
