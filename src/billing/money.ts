const USD_SCALE_DIGITS = 12;
const USD_SCALE = 10n ** BigInt(USD_SCALE_DIGITS);

/**
 * An exact USD value with twelve decimal places.
 *
 * Provider prices are often far smaller than one cent per token. Keeping the
 * scaled value as a bigint prevents quota decisions from depending on
 * JavaScript floating-point rounding.
 */
export class Usd {
  static readonly zero = new Usd(0n);

  private constructor(private readonly atoms: bigint) {}

  static parse(value: string): Usd {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match) {
      throw new TypeError(`Invalid USD value: ${value}`);
    }

    const fraction = match[3] ?? "";
    if (fraction.length > USD_SCALE_DIGITS) {
      throw new RangeError(
        `USD values may have at most ${USD_SCALE_DIGITS} decimal places`,
      );
    }

    const sign = match[1] === "-" ? -1n : 1n;
    const whole = BigInt(match[2]);
    const fractional = BigInt(fraction.padEnd(USD_SCALE_DIGITS, "0"));

    return new Usd(sign * (whole * USD_SCALE + fractional));
  }

  static fromNumber(value: number): Usd {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid USD value: ${value}`);
    }
    return Usd.parse(value.toFixed(USD_SCALE_DIGITS));
  }

  static fromAtoms(atoms: bigint): Usd {
    return new Usd(atoms);
  }

  static min(left: Usd, right: Usd): Usd {
    return left.atoms <= right.atoms ? left : right;
  }

  static sum(values: Iterable<Usd>): Usd {
    let atoms = 0n;
    for (const value of values) atoms += value.atoms;
    return new Usd(atoms);
  }

  add(other: Usd): Usd {
    return new Usd(this.atoms + other.atoms);
  }

  subtract(other: Usd): Usd {
    return new Usd(this.atoms - other.atoms);
  }

  multiply(multiplier: bigint): Usd {
    return new Usd(this.atoms * multiplier);
  }

  equals(other: Usd): boolean {
    return this.atoms === other.atoms;
  }

  lessThan(other: Usd): boolean {
    return this.atoms < other.atoms;
  }

  isZero(): boolean {
    return this.atoms === 0n;
  }

  isPositive(): boolean {
    return this.atoms > 0n;
  }

  isNegative(): boolean {
    return this.atoms < 0n;
  }

  toAtoms(): bigint {
    return this.atoms;
  }

  toString(): string {
    const negative = this.atoms < 0n;
    const absolute = negative ? -this.atoms : this.atoms;
    const whole = absolute / USD_SCALE;
    const fraction = (absolute % USD_SCALE)
      .toString()
      .padStart(USD_SCALE_DIGITS, "0");

    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }
}
