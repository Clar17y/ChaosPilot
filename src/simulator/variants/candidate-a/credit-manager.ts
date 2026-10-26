export class CreditManager {
  private limit: number | null = null;
  private version: number | null = null;
  private reserved: number = 0;
  private used: number = 0;

  public updateLimit(newVersion: number, newLimit: number): boolean {
    if (this.version !== null && newVersion <= this.version) {
      return false;
    }
    this.version = newVersion;
    this.limit = newLimit;
    return true;
  }

  public getLimit(): number | null {
    return this.limit;
  }

  public getVersion(): number | null {
    return this.version;
  }

  public getReserved(): number {
    return this.reserved;
  }

  public getUsed(): number {
    return this.used;
  }

  public getAvailableCredit(): number {
    if (this.limit === null) return 0;
    const totalExposure = this.reserved + this.used;
    return this.limit > totalExposure ? this.limit - totalExposure : 0;
  }

  public canReserve(notional: number): boolean {
    if (this.limit === null) return false;
    return this.reserved + this.used + notional <= this.limit;
  }

  public reserve(notional: number): void {
    this.reserved += notional;
  }

  public convertReserveToUsed(notional: number): void {
    this.reserved -= notional;
    this.used += notional;
  }

  public releaseReserve(notional: number): void {
    this.reserved -= notional;
  }
}
