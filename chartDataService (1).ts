export interface CandleData {
  timestamp: number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

// Base timeframes supported by every data source.
export type TimeFrame = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W' | '1M';

// Extended type that includes the synthetic ALL resolution used by TradingViewChart.
export type ChartTimeFrame = TimeFrame | 'ALL';

// ─── Candle repair / validation ───────────────────────────────────────────────
// Fresh / low-liquidity tokens often return candles where open/high/low are 0 or
// missing while close is valid. We repair those fields rather than rejecting the
// candle, which matches TradingViewChart.sanitizeRawCandles behaviour.
// We only reject candles whose close (the authoritative price) is bad.

function repairCandle(raw: any): CandleData | null {
  if (!raw) return null;
  const ts = Number(raw.timestamp ?? raw.time ?? 0);
  if (!isFinite(ts) || ts <= 0) return null;

  const close = Number(raw.close ?? raw.c ?? 0);
  if (!isFinite(close) || close <= 0) return null;

  const rawOpen  = Number(raw.open  ?? raw.o ?? 0);
  const rawHigh  = Number(raw.high  ?? raw.h ?? 0);
  const rawLow   = Number(raw.low   ?? raw.l ?? 0);

  const open  = isFinite(rawOpen)  && rawOpen  > 0 ? rawOpen  : close;
  const high  = isFinite(rawHigh)  && rawHigh  > 0 ? rawHigh  : close;
  const low   = isFinite(rawLow)   && rawLow   > 0 ? rawLow   : close;

  // Enforce valid OHLC relationships without inventing movement.
  const safeHigh = Math.max(high, open, close);
  const safeLow  = Math.min(low,  open, close);
  if (safeHigh < safeLow) return null;

  const rawVol = Number(raw.volume ?? raw.v ?? 0);
  const volume = isFinite(rawVol) && rawVol > 0 ? rawVol : 0;

  return { timestamp: ts, open, high: safeHigh, low: safeLow, close, volume };
}

function dedupeAndSort(raw: any[]): CandleData[] {
  const seen = new Map<number, CandleData>();
  for (const item of raw) {
    const c = repairCandle(item);
    if (!c) continue;
    const ex = seen.get(c.timestamp);
    if (!ex || c.volume > ex.volume) seen.set(c.timestamp, c);
  }
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Quality scoring ─────────────────────────────────────────────────────────
// Returns a numeric quality score (higher = better). Used by getAllTimeHistory
// to choose the best resolution without relying on candle count alone.

function scoreCandles(cs: CandleData[], bucketMs: number): number {
  if (cs.length === 0) return -Infinity;
  if (cs.length === 1) return 1; // minimal score — usable but only barely

  // Reject if all candles share the same timestamp (vertical wall).
  const uniqueTs = new Set(cs.map(c => c.timestamp)).size;
  if (uniqueTs <= 1) return -Infinity;

  const span = cs[cs.length - 1].timestamp - cs[0].timestamp;
  if (span <= 0) return -Infinity;

  // Flat/doji ratio — repaired candles have open=high=low=close.
  const flatCount = cs.filter(c => Math.abs(c.high - c.low) < Math.max(c.close, 1e-12) * 1e-6).length;
  const flatRatio = flatCount / cs.length;

  // Gap ratio — fraction of expected buckets that are missing.
  const expectedBuckets = Math.max(1, Math.round(span / bucketMs));
  const gapRatio = Math.max(0, 1 - cs.length / expectedBuckets);

  // Volume coverage.
  const withVol = cs.filter(c => c.volume > 0).length;
  const volCoverage = withVol / cs.length;

  // Visual density: candles per 30-day window (normalised).
  const densityScore = Math.min(1, cs.length / 200);

  // Span score: reward longer real history (logarithmic, capped at 1 year).
  const spanScore = Math.min(1, Math.log10(1 + span / 86_400_000) / Math.log10(366));

  const score =
    cs.length * 2 +          // raw count matters but is not the only factor
    spanScore * 80 +          // long real history is valuable
    densityScore * 30 +       // dense charts look better
    volCoverage * 20 -        // prefer real-volume candles
    flatRatio * 40 -          // penalise repaired/synthetic candles
    gapRatio * 30;            // penalise datasets with many gaps

  return score;
}

const TF_BUCKET_MS: Record<ChartTimeFrame, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1H':  3_600_000,
  '4H':  14_400_000,
  '1D':  86_400_000,
  '1W':  604_800_000,
  '1M':  2_592_000_000,
  'ALL': 86_400_000, // placeholder — not used for scoring
};

// ─── Service ──────────────────────────────────────────────────────────────────

const CACHE_DURATION      = 60_000;       // 1 min short TFs
const CACHE_DURATION_LONG = 10 * 60_000;  // 10 min 1W/1M
const CACHE_DURATION_ALL  = 3 * 60_000;   // 3 min ALL

interface CacheEntry { data: CandleData[]; ts: number; mint: string }

class ChartDataService {
  private cache      = new Map<string, CacheEntry>();
  private activeCtrl = new Map<string, AbortController>();

  private cacheKey(mint: string, tf: ChartTimeFrame): string {
    return `${mint}:${tf}`;
  }

  private cacheTTL(tf: ChartTimeFrame): number {
    if (tf === 'ALL') return CACHE_DURATION_ALL;
    if (tf === '1W' || tf === '1M') return CACHE_DURATION_LONG;
    return CACHE_DURATION;
  }

  /**
   * Fetch OHLCV candles. Supports all base TimeFrames plus 'ALL'.
   * - For 'ALL': tries every resolution and selects the best-scoring real dataset.
   * - For others: routes to the chart-data edge function for that timeframe.
   * Never creates fake candles, fake volume, or fake timestamps.
   */
  async getOHLCVData(
    tokenAddress: string,
    timeFrame: ChartTimeFrame = '1H',
    _limitOverride?: number,
  ): Promise<CandleData[]> {
    if (timeFrame === 'ALL') {
      return this.getAllTimeHistory(tokenAddress);
    }
    return this.fetchTimeframe(tokenAddress, timeFrame);
  }

  /** Fetch a single concrete timeframe from the edge function. */
  private async fetchTimeframe(
    tokenAddress: string,
    tf: TimeFrame,
  ): Promise<CandleData[]> {
    const key    = this.cacheKey(tokenAddress, tf);
    const ttl    = this.cacheTTL(tf);
    const cached = this.cache.get(key);
    if (cached && cached.mint === tokenAddress && Date.now() - cached.ts < ttl) {
      return cached.data;
    }

    const prev = this.activeCtrl.get(key);
    if (prev) prev.abort();
    const ctrl = new AbortController();
    this.activeCtrl.set(key, ctrl);

    try {
      const candles = await this.callEdgeFunction(tokenAddress, tf, ctrl.signal);
      if (candles.length > 0) {
        this.cache.set(key, { data: candles, ts: Date.now(), mint: tokenAddress });
      }
      return candles;
    } catch (err: any) {
      if (err?.name === 'AbortError') return this.cache.get(key)?.data ?? [];
      if (__DEV__) console.error('[ChartDataService] fetchTimeframe error:', err?.message ?? err);
      return this.cache.get(key)?.data ?? [];
    } finally {
      if (this.activeCtrl.get(key) === ctrl) this.activeCtrl.delete(key);
    }
  }

  /**
   * ALL timeframe: fetch every resolution in parallel (coarse→fine), score each,
   * return the dataset with the highest quality score.
   * Never creates fake candles — all candidates come from the real edge function.
   */
  private async getAllTimeHistory(tokenAddress: string): Promise<CandleData[]> {
    const key    = this.cacheKey(tokenAddress, 'ALL');
    const cached = this.cache.get(key);
    if (cached && cached.mint === tokenAddress && Date.now() - cached.ts < CACHE_DURATION_ALL) {
      return cached.data;
    }

    const candidates: TimeFrame[] = ['1D', '4H', '1H', '15m', '5m', '1m'];

    // Fetch all candidates in parallel to minimise latency.
    const results = await Promise.allSettled(
      candidates.map(tf => this.fetchTimeframe(tokenAddress, tf))
    );

    let bestCandles: CandleData[] = [];
    let bestScore = -Infinity;
    let bestTf: TimeFrame = '1D';

    for (let i = 0; i < candidates.length; i++) {
      const res = results[i];
      if (res.status !== 'fulfilled') continue;
      const cs = res.value;
      if (cs.length === 0) continue;
      const bucketMs = TF_BUCKET_MS[candidates[i]];
      const score    = scoreCandles(cs, bucketMs);
      if (__DEV__) {
        console.log(`[ChartDataService] ALL candidate ${candidates[i]}: ${cs.length} candles, score=${score.toFixed(1)}`);
      }
      if (score > bestScore) {
        bestScore   = score;
        bestCandles = cs;
        bestTf      = candidates[i];
      }
    }

    if (__DEV__ && bestCandles.length > 0) {
      console.log(`[ChartDataService] ALL selected ${bestTf}: ${bestCandles.length} candles (score=${bestScore.toFixed(1)})`);
    }

    if (bestCandles.length > 0) {
      this.cache.set(key, { data: bestCandles, ts: Date.now(), mint: tokenAddress });
    }
    return bestCandles;
  }

  /** Low-level call to the chart-data edge function for one concrete timeframe. */
  private async callEdgeFunction(
    tokenAddress: string,
    tf: TimeFrame,
    signal: AbortSignal,
  ): Promise<CandleData[]> {
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const anonKey     = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
    if (!supabaseUrl) {
      if (__DEV__) console.warn('[ChartDataService] EXPO_PUBLIC_SUPABASE_URL not set');
      return [];
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/chart-data`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${anonKey}`,
        'apikey':        anonKey,
      },
      body:   JSON.stringify({ mint: tokenAddress, timeframe: tf }),
      signal,
    });

    if (!res.ok) {
      if (__DEV__) console.warn(`[ChartDataService] chart-data returned ${res.status} for ${tf}`);
      return [];
    }

    const result = await res.json() as {
      candles:    any[];
      source:     string;
      marketType: string;
      reason?:    string;
      debug?:     Record<string, any>;
    };

    if (__DEV__ && result.source) {
      console.log(`[ChartDataService] ${tf} source=${result.source} candles=${result.candles?.length ?? 0}`);
    }

    return dedupeAndSort(result.candles ?? []);
  }

  async getSimplePriceHistory(
    tokenAddress: string,
    timeFrame: ChartTimeFrame = '1H',
  ): Promise<{ timestamp: number; price: number }[]> {
    const candles = await this.getOHLCVData(tokenAddress, timeFrame);
    return candles.map(c => ({ timestamp: c.timestamp, price: c.close }));
  }

  /** Clear cached data for a specific mint across all timeframes. */
  clearMintCache(mint: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${mint}:`)) this.cache.delete(key);
    }
    for (const [key, ctrl] of this.activeCtrl.entries()) {
      if (key.startsWith(`${mint}:`)) {
        ctrl.abort();
        this.activeCtrl.delete(key);
      }
    }
  }

  clearCache() {
    this.cache.clear();
    for (const ctrl of this.activeCtrl.values()) ctrl.abort();
    this.activeCtrl.clear();
  }
}

export const chartDataService = new ChartDataService();
