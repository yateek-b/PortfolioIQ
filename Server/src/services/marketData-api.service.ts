const BASE_URL = "https://api.twelvedata.com";

export interface PricePoint {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TimeSeriesResponse {
  meta: {
    symbol: string;
    interval: string;
    currency: string;
    exchange_timezone: string;
  };
  values: PricePoint[];
}

interface CacheEntry {
  data: PricePoint[];
  timestamp: number;
}

export class MarketDataAPIService {
  private apiKey: string;
  private cache: Map<string, CacheEntry> = new Map();
  private CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    if (!process.env.TWELVE_DATA_API_KEY) {
      throw new Error("TWELVE_DATA_API_KEY is not set");
    }
    this.apiKey = process.env.TWELVE_DATA_API_KEY;
  }

  // ---------- CORE FETCH WITH RETRY ---------- //
  private async fetchWithRetry(url: string, retries = 2): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url);

        if (!res.ok) {
          throw new Error(`HTTP Error: ${res.status}`);
        }

        const data = await res.json();

        if (data.status === "error") {
          throw new Error(data.message);
        }

        return data;
      } catch (err) {
        if (attempt === retries) {
          console.error("Final API failure:", err);
          throw err;
        }
      }
    }
  }

  // ---------- URL BUILDER ---------- //
  private buildUrl(endpoint: string, params: Record<string, any>) {
    const url = new URL(`${BASE_URL}/${endpoint}`);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    url.searchParams.append("apikey", this.apiKey);

    return url.toString();
  }

  // ---------- CACHE CHECK ---------- //
  private getCache(key: string): PricePoint[] | null {
    const entry = this.cache.get(key);

    if (!entry) return null;

    const isExpired = Date.now() - entry.timestamp > this.CACHE_TTL;

    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  private setCache(key: string, data: PricePoint[]) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  // ---------- 1. HISTORICAL PRICES ---------- //
  async getHistoricalPrices(
    symbol: string,
    interval: string = "1day",
    outputsize: number = 100
  ): Promise<TimeSeriesResponse> {
    const cacheKey = `${symbol}_${interval}_${outputsize}`;

    const cached = this.getCache(cacheKey);
    if (cached) {
      return {
        meta: {} as any,
        values: cached,
      };
    }

    const url = this.buildUrl("time_series", {
      symbol,
      interval,
      outputsize,
      order: "ASC",
    });

    const data = await this.fetchWithRetry(url);

    const parsedValues: PricePoint[] = data.values.map((item: any) => ({
      datetime: item.datetime,
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      volume: item.volume ? parseFloat(item.volume) : undefined,
    }));

    this.setCache(cacheKey, parsedValues);

    return {
      meta: data.meta,
      values: parsedValues,
    };
  }

  // ---------- 2. MULTIPLE SYMBOLS (SAFE BATCH) ---------- //
  async getMultiplePrices(
    symbols: string[]
  ): Promise<Record<string, PricePoint[]>> {
    const results: Record<string, PricePoint[]> = {};

    const BATCH_SIZE = 10;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (symbol) => {
          const data = await this.getHistoricalPrices(symbol);
          return { symbol, values: data.values };
        })
      );

      batchResults.forEach(({ symbol, values }) => {
        results[symbol] = values;
      });
    }

    return results;
  }

  // ---------- 3. INDEX PRICES ---------- //
  async getIndexPrices(
    indexSymbol: string = "SPX"
  ): Promise<TimeSeriesResponse> {
    return this.getHistoricalPrices(indexSymbol, "1day", 200);
  }

  // ---------- 4. LATEST PRICE ---------- //
  async getLatestPrice(symbol: string): Promise<number> {
    const url = this.buildUrl("price", { symbol });
    const data = await this.fetchWithRetry(url);

    return parseFloat(data.price);
  }

  // ---------- 5. RETURNS ---------- //
  calculateReturns(prices: PricePoint[]): number[] {
    const returns: number[] = [];

    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1].close;
      const curr = prices[i].close;

      returns.push((curr - prev) / prev);
    }

    return returns;
  }
}