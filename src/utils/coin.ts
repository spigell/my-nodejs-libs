export class Coin {
  id: string;
  symbol: string;
  decimals: number;

  constructor(id: string, symbol: string, decimals: number) {
    this.symbol = symbol;
    this.decimals = decimals;
    this.id = id;
  }

  /**
   * Converts a given amount to its decimal representation.
   * @param amount The integer amount to convert.
   * @returns The amount adjusted for the coin's decimals.
   */
  toPretty(amount: number): string {
    return (amount * Math.pow(10, -this.decimals)).toFixed(this.decimals);
  }

  /**
   * Converts a decimal amount back to its integer representation.
   * @param decimalAmount The decimal amount to convert.
   * @returns The integer representation of the decimal amount.
   */
  toRawAmount(decimalAmount: number): number {
    return Math.round(decimalAmount * Math.pow(10, this.decimals));
  }
}
