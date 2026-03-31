const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface MacroDataPoint {
  date: string;
  value: number;
}

export class MacroAPIService {
  private apiKey: string;
  private cache: Map<string, CacheEntry<any>> = new Map();
  private CACHE_TTL = 15 * 60 * 1000; // 15 min (macro changes slowly)

  constructor() {
    if (!process.env.FRED_API_KEY) {
      throw new Error("FRED_API_KEY is not set");
    }
    this.apiKey = process.env.FRED_API_KEY;
  }

  // ---------- FETCH WITH RETRY ---------- //
  private async fetchWithRetry(url: string, retries = 2): Promise<any> {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url);

        if (!res.ok) {
          throw new Error(`HTTP Error: ${res.status}`);
        }

        return await res.json();
      } catch (err) {
        if (i === retries) throw err;
      }
    }
  }

  // ---------- CACHE ---------- //
  private getCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  private setCache(key: string, data: any) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  // ---------- URL BUILDER ---------- //
  private buildUrl(series_id: string) {
    const url = new URL(BASE_URL);

    url.searchParams.append("series_id", series_id);
    url.searchParams.append("api_key", this.apiKey);
    url.searchParams.append("file_type", "json");

    return url.toString();
  }

  // ---------- GENERIC FETCH ---------- //
  private async getSeries(seriesId: string): Promise<MacroDataPoint[]> {
    const cacheKey = `macro_${seriesId}`;

    const cached = this.getCache<MacroDataPoint[]>(cacheKey);
    if (cached) return cached;

    const url = this.buildUrl(seriesId);
    const data = await this.fetchWithRetry(url);

    const parsed: MacroDataPoint[] = data.observations
      .filter((item: any) => item.value !== ".")
      .map((item: any) => ({
        date: item.date,
        value: parseFloat(item.value),
      }));

    this.setCache(cacheKey, parsed);

    return parsed;
  }

  // ---------- PUBLIC FUNCTIONS ---------- //

  async getInterestRates() {
    return this.getSeries("FEDFUNDS");
  }

  async getCPI() {
    return this.getSeries("CPIAUCSL");
  }

  async getGDP() {
    return this.getSeries("GDP");
  }

  async getUnemployment() {
    return this.getSeries("UNRATE");
  }

  async getYieldCurve() {
    return this.getSeries("T10Y2Y"); // 10Y - 2Y spread
  }
}