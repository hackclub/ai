import { type AsnResponse, Reader } from "mmdb-lib";

export type IpNetwork = { asn: number; name: string };

const REFRESH_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 5 * 60 * 1_000;

/** DB-IP publishes a Lite database each month; early in a month only last month's exists. */
const sourceUrls = (now: Date) =>
  [0, 1].map((monthsAgo) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
    return `https://download.db-ip.com/free/dbip-asn-lite-${month.toISOString().slice(0, 7)}.mmdb.gz`;
  });

/**
 * DB-IP's free IP-to-ASN database (CC BY 4.0), held in memory. It downloads
 * in the background and lookups answer null until the first load lands.
 */
export class IpNetworkTable {
  private reader: Reader<AsnResponse> | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly fetch: typeof fetch;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  /** Starts a download when the database is missing or a day old; never throws. */
  refresh(): Promise<void> {
    if (this.loading || Date.now() - this.loadedAt < (this.reader ? REFRESH_MS : RETRY_MS)) {
      return this.loading ?? Promise.resolve();
    }
    this.loading = (async () => {
      try {
        for (const url of sourceUrls(new Date())) {
          const response = await this.fetch(url);
          if (!response.ok) continue;
          const database = Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()));
          this.reader = new Reader<AsnResponse>(Buffer.from(database.buffer, database.byteOffset, database.byteLength));
          return;
        }
        throw new Error("no DB-IP ASN database for this or last month");
      } catch (error) {
        console.warn("IP network database refresh failed", error);
      } finally {
        this.loadedAt = Date.now();
        this.loading = null;
      }
    })();
    return this.loading;
  }

  lookup(ip: string): IpNetwork | null {
    void this.refresh();
    if (!this.reader) return null;
    try {
      const record = this.reader.get(ip);
      if (!record?.autonomous_system_number) return null;
      return { asn: record.autonomous_system_number, name: record.autonomous_system_organization ?? "" };
    } catch {
      // Not an IP address.
      return null;
    }
  }
}
