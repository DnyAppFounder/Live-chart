import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  Text,
  TouchableOpacity,
  Image,
  useWindowDimensions,
  Animated,
  ScrollView,
  PanResponder,
  Platform,
} from 'react-native';
import Svg, {
  Path,
  Line,
  Rect,
  Text as SvgText,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
  G,
  Circle,
  ClipPath,
} from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import {
  TrendingUp,
  TrendingDown,
  ChartBar as BarChart2,
  Activity,
  ChartLine as LineChart,
  ChartCandlestick as CandlestickChart,
  ChartArea as AreaChart,
  Copy,
  CircleCheck as CheckCircle2,
  SlidersHorizontal,
} from 'lucide-react-native';
import { colors, spacing, fontSize, borderRadius } from '@/constants/theme';
import { DawenProChart } from '@/components/DawenProChart';
import { CandleData, TimeFrame, ChartTimeFrame } from '@/services/chartDataService';
import { liveTokenStore } from '@/services/liveTokenStore';
import { useChartAnimationEngine } from '@/hooks/useChartAnimationEngine';
import { useRealtimeChart, LiveCandleData } from '@/hooks/useRealtimeChart';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// How long a live candle stays "active" before its pulse fades out.
// After this window with no new real trade the dot stops pulsing.
const LIVE_CANDLE_STALE_MS = 5 * 60_000; // 5 minutes

export type ChartMode = 'line' | 'area' | 'candlestick' | 'bonding' | 'bar' | 'mountain';
type ValueMode = 'mcap' | 'price';

export interface TokenInfo {
  name: string;
  symbol: string;
  image?: string;
  price: number;
  priceChange24h: number;
  marketCap?: number;
  /** Real circulating/total supply from on-chain or API metadata (tokens, not lamports). */
  totalSupply?: number;
  pairAddress?: string;
  address?: string;
}

interface TradingViewChartProps {
  tokenInfo?: TokenInfo;
  symbol?: string;
  currentPrice?: number;
  pairAddress?: string;
  tokenMint?: string;
  chartHeight?: number;
  chartWidth?: number;
  hideTokenHeader?: boolean;
  valueMode?: ValueMode;
  onValueModeChange?: (v: ValueMode) => void;
}

const ALL_TIMEFRAMES: { key: ChartTimeFrame; label: string }[] = [
  { key: '1s',  label: '1s' },
  { key: '1m',  label: '1m' },
  { key: '5m',  label: '5m' },
  { key: '15m', label: '15m' },
  { key: '1H',  label: '1H' },
  { key: '4H',  label: '4H' },
  { key: '1D',  label: '1D' },
  { key: '1W',  label: '1W' },
  { key: '1M',  label: '1M' },
  { key: 'ALL', label: 'ALL' },
];

const CHART_MODES: { key: ChartMode; icon: any; label: string }[] = [
  { key: 'area',        icon: AreaChart,       label: 'Area' },
  { key: 'line',        icon: LineChart,        label: 'Line' },
  { key: 'candlestick', icon: CandlestickChart, label: 'Candles' },
  { key: 'bar',         icon: BarChart2,        label: 'Bars' },
  { key: 'mountain',    icon: Activity,         label: 'Mountain' },
  { key: 'bonding',     icon: TrendingUp,       label: 'Pulse' },
];

const TIME_H = 18;

const BUCKET_MS: Record<string, number> = {
  '1s':  1_000,
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1H':  3_600_000,
  '4H':  14_400_000,
  '1D':  86_400_000,
  '1W':  604_800_000,
  '1M':  2_592_000_000,
  'ALL': 86_400_000,
};

const VISIBLE_BUCKETS: Record<string, number> = {
  '1s':  90,
  '1m':  45,
  '5m':  72,
  '15m': 48,
  '1H':  48,
  '4H':  42,
  '1D':  30,
  '1W':  26,
  '1M':  12,
  'ALL': 60,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function filterValidCandles(cs: CandleData[]): CandleData[] {
  return cs.filter(c => {
    if (!c || !isFinite(c.timestamp) || c.timestamp <= 0) return false;
    if (!isFinite(c.open)  || c.open  <= 0) return false;
    if (!isFinite(c.close) || c.close <= 0) return false;
    if (!isFinite(c.high)  || c.high  <= 0) return false;
    if (!isFinite(c.low)   || c.low   <= 0) return false;
    const eps = c.high * 1e-8;
    if (c.high < c.low - eps || c.high < c.open - eps || c.high < c.close - eps) return false;
    return true;
  });
}

// Repair and validate raw API candles before storing.
// Fresh/new tokens may return partial OHLC where open/high/low are 0 but close is valid.
// Rules:
//  - Reject candles with invalid timestamp or close <= 0.
//  - Repair open/high/low by falling back to close — never invent movement.
//  - Enforce high >= open, high >= close; low <= open, low <= close.
//  - Reject if high < low after repair (truly impossible candle).
//  - Zero or negative volume is clamped to 0 (no volume bar will be rendered).
function sanitizeRawCandles(cs: CandleData[]): CandleData[] {
  const result: CandleData[] = [];
  for (const c of cs) {
    if (!c) continue;
    const ts = c.timestamp;
    if (!isFinite(ts) || ts <= 0) continue;
    const close = isFinite(c.close) && c.close > 0 ? c.close : 0;
    if (close <= 0) continue;
    // Repair missing OHLC fields — fall back to close, never invent movement
    const open  = isFinite(c.open)  && c.open  > 0 ? c.open  : close;
    const high  = isFinite(c.high)  && c.high  > 0 ? c.high  : close;
    const low   = isFinite(c.low)   && c.low   > 0 ? c.low   : close;
    // Enforce valid OHLC relationship
    const safeHigh = Math.max(high, open, close);
    const safeLow  = Math.min(low,  open, close);
    if (safeHigh < safeLow) continue; // should never happen after above, but guard anyway
    result.push({
      timestamp: ts,
      open,
      high: safeHigh,
      low:  safeLow,
      close,
      volume: isFinite(c.volume) && c.volume > 0 ? c.volume : 0,
    });
  }
  return result;
}

// Keep the best real candle per bucket (highest volume wins; real candles with volume take priority over zero-volume visual guides).
function dedupByBucket(cs: CandleData[], bucketMs: number): CandleData[] {
  if (cs.length === 0) return cs;
  const map = new Map<number, CandleData>();
  for (const c of cs) {
    const bucket = Math.floor(c.timestamp / bucketMs) * bucketMs;
    const existing = map.get(bucket);
    if (!existing || c.volume > existing.volume) {
      map.set(bucket, { ...c, timestamp: bucket });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}



const TIMEFRAME_ORDER: TimeFrame[] = ['1m', '5m', '15m', '1H', '4H', '1D', '1W', '1M'];

function timeframeRank(tf: TimeFrame): number {
  const idx = TIMEFRAME_ORDER.indexOf(tf);
  return idx >= 0 ? idx : 0;
}

function getLowerOrEqualTimeframes(tf: TimeFrame): TimeFrame[] {
  const rank = timeframeRank(tf);
  // Start with the selected timeframe, then try finer real sources that can be
  // aggregated upward without inventing smaller candles.
  const frames = [tf, ...TIMEFRAME_ORDER.slice(0, rank).reverse()];
  return Array.from(new Set(frames));
}

function aggregateCandlesToTimeframe(cs: CandleData[], targetTf: TimeFrame): CandleData[] {
  const bucketMs = BUCKET_MS[targetTf] ?? 60_000;
  const input = sanitizeRawCandles(cs).sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, CandleData>();

  for (const c of input) {
    const bucket = Math.floor(c.timestamp / bucketMs) * bucketMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        timestamp: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume > 0 ? c.volume : 0,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume > 0 ? c.volume : 0;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function scoreCandleSet(cs: CandleData[], targetTf: TimeFrame): number {
  const cleaned = sanitizeRawCandles(cs);
  if (cleaned.length === 0) return 0;
  const bucketMs = BUCKET_MS[targetTf] ?? 60_000;
  const sorted = cleaned.sort((a, b) => a.timestamp - b.timestamp);
  const span = Math.max(sorted[sorted.length - 1].timestamp - sorted[0].timestamp, bucketMs);
  const countScore = Math.min(sorted.length, 120) * 10;
  const spanScore = Math.min(span / bucketMs, 120);
  const withVol = sorted.filter(c => c.volume > 0).length;
  const volumeScore = withVol * 2;
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i].timestamp - sorted[i - 1].timestamp);
  const gapPenalty = sorted.length > 1 ? Math.min(maxGap / bucketMs, 80) : 30;
  const flatCount = sorted.filter(c => Math.abs(c.high - c.low) < Math.max(c.close, 1e-12) * 1e-6).length;
  const flatPenalty = (flatCount / sorted.length) * 40;
  return countScore + spanScore + volumeScore - gapPenalty - flatPenalty;
}

// Infer the median candle-to-candle gap in ms from a sorted candle array.
function inferBucketMs(cs: CandleData[]): number {
  if (cs.length < 2) return BUCKET_MS['1D'];
  const gaps = cs.slice(1).map((c, i) => c.timestamp - cs[i].timestamp).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Map a bucket duration in ms to the closest base TimeFrame.
function msToBestTimeFrame(ms: number): TimeFrame {
  const candidates: [number, TimeFrame][] = [
    [BUCKET_MS['1m'],  '1m'],
    [BUCKET_MS['5m'],  '5m'],
    [BUCKET_MS['15m'], '15m'],
    [BUCKET_MS['1H'],  '1H'],
    [BUCKET_MS['4H'],  '4H'],
    [BUCKET_MS['1D'],  '1D'],
    [BUCKET_MS['1W'],  '1W'],
    [BUCKET_MS['1M'],  '1M'],
  ];
  let best: TimeFrame = '1D';
  let bestDiff = Infinity;
  for (const [bMs, tf] of candidates) {
    const diff = Math.abs(ms - bMs);
    if (diff < bestDiff) { bestDiff = diff; best = tf; }
  }
  return best;
}

function chooseBestCandleSet(candidates: CandleData[][], targetTf: TimeFrame): CandleData[] {
  let best: CandleData[] = [];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const cleaned = sanitizeRawCandles(candidate);
    const score = scoreCandleSet(cleaned, targetTf);
    if (score > bestScore) {
      bestScore = score;
      best = cleaned;
    }
  }
  return best;
}

function fmtPrice(p: number): string {
  if (!p || p === 0) return '0';
  if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  if (p >= 0.000001) return p.toFixed(8);
  return p.toExponential(3);
}
function fmtMcap(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtTime(ts: number, tf: ChartTimeFrame): string {
  const d = new Date(ts);
  if (tf === '1D' || tf === '1W' || tf === '1M' || tf === 'ALL') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (tf === '1s') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtTimeByStep(ts: number, stepMs: number): string {
  const d = new Date(ts);
  // Monthly or longer: show "Mon YYYY"
  if (stepMs >= 30 * 86_400_000) {
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  // Weekly: show "Mon D"
  if (stepMs >= 7 * 86_400_000) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Daily: show "Mon D"
  if (stepMs >= 86_400_000) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Sub-daily: show date at midnight, otherwise time
  if (d.getHours() === 0 && d.getMinutes() === 0) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Sub-minute: show HH:MM:SS
  if (stepMs < 60_000) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtValue(v: number, mode: ValueMode): string {
  return mode === 'mcap' ? fmtMcap(v) : `$${fmtPrice(v)}`;
}

// Module-level cache: resolved pair address per token mint.
// Avoids a redundant DexScreener fetch every time the component remounts for the same token.
const resolvedPairCache = new Map<string, string>();

// ─── Main component ───────────────────────────────────────────────────────────
export function TradingViewChart({
  tokenInfo,
  symbol,
  currentPrice,
  pairAddress,
  tokenMint,
  chartHeight,
  chartWidth: propChartWidth,
  hideTokenHeader = false,
  valueMode: externalValueMode,
  onValueModeChange,
}: TradingViewChartProps) {
  const { width: screenWidth } = useWindowDimensions();
  const isMobile = screenWidth < 768;
  const isNarrow = screenWidth < 390;
  const chartWidth = propChartWidth ?? (isMobile ? Math.min(screenWidth - 16, 600) : screenWidth - 32);
  const CHART_H  = chartHeight ?? (isMobile ? 460 : 240);
  const VOL_H    = isMobile ? 60  : 40;
  const PAD      = { top: 10, right: isMobile ? (isNarrow ? 62 : 68) : 60, bottom: 4, left: 4 };

  const resolvedInfo: TokenInfo | undefined = tokenInfo ?? (symbol != null ? {
    name: symbol, symbol, price: currentPrice ?? 0, priceChange24h: 0, pairAddress,
  } : undefined);

  const [timeframe, setTimeframe] = useState<ChartTimeFrame>('1H');
  // Tracks which resolution was actually used when timeframe === 'ALL'.
  // Starts at 1D; auto-degrades to 1H or 5m for newer/sparser tokens.
  const [allEffectiveTf, setAllEffectiveTf] = useState<TimeFrame>('1D');

  const allEffectiveBucketMs = timeframe === 'ALL'
    ? (BUCKET_MS[allEffectiveTf] ?? 86_400_000)
    : (BUCKET_MS[timeframe] ?? 3_600_000);

  // ── Real-time data layer ─────────────────────────────────────────────────────
  // useRealtimeChart owns: historical load, Helius WS, Supabase realtime,
  // DexScreener poll fallback. Every confirmed trade updates the real candles array.
  const {
    candles: rtCandles,
    livePrice: rtLivePrice,
    livePriceTs: rtLivePriceTs,
    activeLiveCandle: rtActiveLiveCandle,
    isLoading: rtLoading,
    lastTradeTs,
  } = useRealtimeChart(tokenMint, timeframe, allEffectiveBucketMs);

  const candles           = rtCandles;
  const activeLiveCandle  = rtActiveLiveCandle;
  const activeLiveCandleRef = useRef<LiveCandleData | null>(null);
  const loading  = rtLoading;
  const hasData  = candles.length > 0;

  // For ALL timeframe: infer effective resolution from median candle spacing.
  useEffect(() => {
    if (timeframe !== 'ALL' || candles.length < 2) return;
    const medianGap = inferBucketMs(candles);
    const effectiveTf = msToBestTimeFrame(medianGap);
    setAllEffectiveTf(effectiveTf);
  }, [timeframe, candles]);

  const [mode, setMode] = useState<ChartMode>('area');
  const [internalValueMode, setInternalValueMode] = useState<ValueMode>('mcap');
  const valueMode: ValueMode = externalValueMode ?? internalValueMode;
  const setValueMode = (v: ValueMode) => {
    if (onValueModeChange) onValueModeChange(v);
    else setInternalValueMode(v);
  };
  // livePrice: hook-provided price takes priority; fallback to local quote-poll updates.
  const [localLivePrice, setLivePrice] = useState<number | null>(null);
  const livePrice: number | null = rtLivePrice ?? localLivePrice;
  const [live24hChange, setLive24hChange] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [showModePanel, setShowModePanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showProChart, setShowProChart] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [showPriceLine, setShowPriceLine] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [resolvedPairAddr, setResolvedPairAddr] = useState<string | null>(pairAddress ?? null);
  const [crosshair, setCrosshair] = useState<{
    x: number; y: number; idx: number; price: number; ts: number; pct: number;
  } | null>(null);
  const headerPulseAnim = useRef(new Animated.Value(1)).current;
  const chartPulseAnim  = useRef(new Animated.Value(0)).current;

  const plotWRef            = useRef(0);
  // Always mirrors the engine's current panOffsetMs so PanResponder closures
  // don't read stale React state from the initial render.
  const currentPanOffsetMsRef = useRef(0);
  // ms-based pan offset captured at gesture start (delta-from-start math).
  const panStartOffsetMsRef = useRef(0);
  // 'idle' → 'crosshair' or 'pan' — locked until touch release.
  const gestureModeRef      = useRef<'idle' | 'crosshair' | 'pan'>('idle');
  const touchStartXRef      = useRef(0);
  const touchStartYRef      = useRef(0);
  const touchStartTimeRef   = useRef(0);

  // All ranked DexScreener pair addresses for the current token.
  // Stored so we can fall back to the next pair if the primary WS fails repeatedly.
  const rankedPairsRef = useRef<string[]>([]);

  // Stable price scale — recomputed only when visible candle set changes, not on clock tick.
  const priceScaleRef    = useRef({ maxP: 0, minP: 0, priceRange: 1, maxVol: 1 });
  const priceScaleKeyRef = useRef('');

  const pollTimerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef               = useRef<WebSocket | null>(null);
  const livePriceRef        = useRef<number | null>(null);
  const wsDebounceRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRetryCountRef     = useRef(0);
  const svgContainerRef = useRef<View>(null);
  const svgOffsetRef   = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const candlesRef     = useRef<CandleData[]>([]);
  const displayCandlesRef = useRef<CandleData[]>([]);
  const pairAddrRef    = useRef<string | null>(pairAddress ?? null);
  const reqIdRef       = useRef(0);
  const prevMintRef    = useRef<string | undefined>(undefined);
  const hasAutoScrolledRef = useRef(false);
  const timeframeRef   = useRef<ChartTimeFrame>('1H');
  const prevExternalPriceRef = useRef<number>(0);
  // True only when the user explicitly drags the chart; reset on token/timeframe change.
  // Prevents "Return to Live" from appearing after auto-scroll adjustments.
  const userPannedRef = useRef(false);

  // Centralized price pipeline: track timestamp of latest accepted price to prevent
  // stale API responses from overwriting fresher live prices.
  const latestPriceTsRef = useRef<number>(0);

  // Local visibility mirror — kept in sync with engine, also used as WS reconnect guard.
  const chartVisibleRef = useRef(true);
  // Set to true while applying a liveTokenStore-sourced update to prevent push-back.
  const fromStoreRef = useRef(false);
  // Set to true once the user manually picks a chart mode; suppresses auto-detection.
  const userSelectedModeRef = useRef(false);
  // Stable supply: computed once from snapshot, never drifts with livePrice.
  // Reset when tokenMint changes so a new token gets a fresh calculation.
  const stableSupplyRef = useRef<number | null>(null);

  const leftTimeRef   = useRef<number>(Date.now() - 3_600_000 * 60);
  const visibleMsRef  = useRef<number>(3_600_000 * 60);
  const bucketMsRef   = useRef<number>(3_600_000);

  // ── Animation engine ────────────────────────────────────────────────────────
  // maxPanBackMs: how far back in time the user can scroll, anchored to the
  // oldest loaded real candle so we never pan into a blank empty void.
  const panBucketMsForLimit = timeframe === 'ALL'
    ? (BUCKET_MS[allEffectiveTf] ?? 3_600_000)
    : (BUCKET_MS[timeframe] ?? 3_600_000);
  const panVisibleMsForLimit = (VISIBLE_BUCKETS[timeframe] ?? 48) * panBucketMsForLimit;
  const maxPanBackMs = candles.length > 0
    ? Math.max(0, Date.now() - candles[0].timestamp + panVisibleMsForLimit)
    : 0;
  const animEngine = useChartAnimationEngine(maxPanBackMs);
  // Interpolated price from animation engine — available at all render sites below.
  const interpP = animEngine.state.interpolatedPrice;

  useEffect(() => { livePriceRef.current = livePrice; }, [livePrice]);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { pairAddrRef.current = resolvedPairAddr; }, [resolvedPairAddr]);
  useEffect(() => { timeframeRef.current = timeframe; }, [timeframe]);
  useEffect(() => { activeLiveCandleRef.current = activeLiveCandle; }, [activeLiveCandle]);

  // Feed every real trade price into the animation engine so it interpolates
  // from the previous rendered price to the true new price over ~150 ms.
  useEffect(() => {
    if (rtLivePrice && rtLivePrice > 0) {
      animEngine.actions.setTargetPrice(rtLivePrice);
    }
  }, [rtLivePrice, rtLivePriceTs]);

  // Keep currentPanOffsetMsRef in sync so PanResponder (created once) reads fresh value.
  currentPanOffsetMsRef.current = animEngine.state.panOffsetMs;

  // Resolve best pair address from DexScreener when token mint changes.
  // Prefers pairs with usable live price data (non-zero priceUsd + liquidity/volume).
  // Caches the resolved address per mint so the fetch only happens once per token.
  useEffect(() => {
    if (!tokenMint) return;
    if (pairAddress) {
      setResolvedPairAddr(pairAddress);
      pairAddrRef.current = pairAddress;
      return;
    }
    const cached = resolvedPairCache.get(tokenMint);
    if (cached) {
      setResolvedPairAddr(cached);
      pairAddrRef.current = cached;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const pairs: any[] = (data.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (pairs.length === 0 || cancelled) return;
        // Prefer pairs with usable live price data (non-zero priceUsd and some activity).
        // This avoids getting stuck on a dead AMM with no recent trades.
        const usable = pairs.filter((p: any) =>
          parseFloat(p.priceUsd || '0') > 0 &&
          ((p.liquidity?.usd || 0) > 0 || (p.volume?.h24 || 0) > 0)
        );
        const ranked = (usable.length > 0 ? usable : pairs)
          .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const allAddrs = ranked.map((p: any) => p.pairAddress).filter(Boolean) as string[];
        const addr = allAddrs[0];
        if (!cancelled && addr) {
          // Store all ranked pairs for WS candidate rotation; do not cache until OHLCV validates.
          rankedPairsRef.current = allAddrs;
          setResolvedPairAddr(addr);
          pairAddrRef.current = addr;
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [tokenMint, pairAddress]);

  // Header WS dot pulse — always running
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(headerPulseAnim, { toValue: 2.2, duration: 400, useNativeDriver: true }),
      Animated.timing(headerPulseAnim, { toValue: 1,   duration: 400, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  // Chart endpoint pulse — only when a confirmed real-trade live candle is active and fresh.
  // quotePoll candles (DexScreener WS, Jupiter REST, liveTokenStore) update the chart line
  // but are NOT confirmed on-chain events, so the pulse ring must not fire for them.
  useEffect(() => {
    if (!activeLiveCandle || activeLiveCandle.sourceType !== 'realTrade') {
      chartPulseAnim.setValue(0);
      return;
    }
    const isStale = Date.now() - activeLiveCandle.tradeTimestamp > LIVE_CANDLE_STALE_MS;
    if (isStale) {
      chartPulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(chartPulseAnim, { toValue: 0.65, duration: 250, useNativeDriver: false }),
      Animated.timing(chartPulseAnim, { toValue: 0,    duration: 650, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [activeLiveCandle]);

  // Viewport visibility — wire IntersectionObserver to the animation engine
  // and keep the local chartVisibleRef in sync for the WS reconnect guard.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof IntersectionObserver === 'undefined') return;
    if (!hasData) {
      chartVisibleRef.current = true;
      animEngine.actions.setChartVisible(true);
      return;
    }
    const el = svgContainerRef.current as unknown as Element;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      const v = entries[0]?.isIntersecting ?? true;
      chartVisibleRef.current = v;
      animEngine.actions.setChartVisible(v);
    }, { threshold: 0 });
    obs.observe(el);
    return () => {
      obs.disconnect();
      chartVisibleRef.current = true;
      animEngine.actions.setChartVisible(true);
    };
  }, [hasData, animEngine.actions]);

  // ── Single price pipeline ────────────────────────────────────────────────────
  // All price sources funnel through applyLivePrice. Each call carries a timestamp
  // so that a late-arriving REST response never overwrites a fresher live price.
  // isRealTrade = true  → a timestamped on-chain trade; may create/update activeLiveCandle.
  // isRealTrade = false → REST/WS quote, DexScreener, Jupiter; updates display only.
  // The active live candle (current bucket only) is updated separately from history.
  // ── Quote-only price applier ─────────────────────────────────────────────────
  // Real trades are handled by useRealtimeChart. This function handles quote-only
  // sources: DexScreener WS, Jupiter REST poll, liveTokenStore, external snapshot.
  // It updates the display price and pushes to liveTokenStore but does NOT
  // create or modify the activeLiveCandle (the hook owns that).
  const applyLivePrice = useCallback((
    price: number,
    sourceTs?: number,
    _isRealTrade = false,
  ) => {
    if (!price || price <= 0) return;
    const ts = sourceTs ?? Date.now();
    if (ts < latestPriceTsRef.current - 1000) return;
    if (livePriceRef.current === price && ts <= latestPriceTsRef.current) return;
    latestPriceTsRef.current = Math.max(latestPriceTsRef.current, ts);
    livePriceRef.current = price;
    setLivePrice(price);
    if (tokenMint && !fromStoreRef.current) liveTokenStore.pushPrice(tokenMint, price);
  }, [tokenMint]);

  const connectWebSocket = useCallback((pairAddr: string) => {
    if (typeof WebSocket === 'undefined') return;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    try {
      const wsUrl = `wss://io.dexscreener.com/dex/screener/pair/solana/${pairAddr}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen  = () => { setWsConnected(true); };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const np = msg?.pair?.priceUsd ? parseFloat(msg.pair.priceUsd) : null;
          if (!np || isNaN(np) || np <= 0) return;
          const now = Date.now();
          if (wsDebounceRef.current) {
            livePriceRef.current = np;
            latestPriceTsRef.current = Math.max(latestPriceTsRef.current, now);
            return;
          }
          wsDebounceRef.current = setTimeout(() => {
            wsDebounceRef.current = null;
            const price = livePriceRef.current ?? np;
            applyLivePrice(price, Date.now(), false);
          }, 400);
          livePriceRef.current = np;
        } catch {}
      };
      ws.onerror = () => { try { setWsConnected(false); } catch {} };
      ws.onclose = () => {
        try { setWsConnected(false); } catch {}
        wsRef.current = null;
        // Stop retrying after 5 attempts — pair is likely unavailable or bad.
        if (wsRetryCountRef.current >= 5) {
          // Try the next ranked pair if available (max 3 pairs total to avoid runaway loops).
          const currentIdx = rankedPairsRef.current.findIndex(a => a === pairAddrRef.current);
          const nextAddr = currentIdx >= 0 && currentIdx < 2
            ? rankedPairsRef.current[currentIdx + 1]
            : undefined;
          if (nextAddr) {
            pairAddrRef.current = nextAddr;
            setResolvedPairAddr(nextAddr);
            wsRetryCountRef.current = 0;
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            wsReconnectTimerRef.current = setTimeout(() => {
              wsReconnectTimerRef.current = null;
              if (wsRef.current === null) connectWebSocket(nextAddr);
            }, 5000);
          }
          return;
        }
        // Don't reconnect when the tab or chart is not visible.
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!chartVisibleRef.current) return;
        // Exponential backoff: 5s → 10s → 20s → 40s → 60s (cap).
        const delay = Math.min(5000 * Math.pow(2, wsRetryCountRef.current), 60_000);
        wsRetryCountRef.current++;
        if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = setTimeout(() => {
          wsReconnectTimerRef.current = null;
          if (pairAddrRef.current && wsRef.current === null) connectWebSocket(pairAddrRef.current);
        }, delay);
      };
    } catch { setWsConnected(false); }
  }, [applyLivePrice]);

  // On token mint change: clear display state so new token starts fresh.
  // candles, activeLiveCandle, loading, hasData are reset by useRealtimeChart.
  useEffect(() => {
    if (prevMintRef.current === tokenMint) return;
    prevMintRef.current = tokenMint;
    setLivePrice(null);
    setLive24hChange(null);
    livePriceRef.current = null;
    latestPriceTsRef.current = 0;
    hasAutoScrolledRef.current = false;
    wsRetryCountRef.current = 0;
    if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
    userSelectedModeRef.current = false;
    stableSupplyRef.current = null;
    setAllEffectiveTf('1D');
    rankedPairsRef.current = [];
  }, [tokenMint]);

  // Auto-select chart mode based on token trading density.
  // Uses gap/volume analysis to detect sparse tokens — these look bad with area fill.
  // Skipped once the user manually picks a mode.
  useEffect(() => {
    if (!hasData || candles.length === 0 || userSelectedModeRef.current) return;
    const sevenDaysAgo = Date.now() - 7 * 86_400_000;
    const recent = candles.filter(c => c.timestamp >= sevenDaysAgo);
    const count = recent.length;
    if (count < 5) { setMode('candlestick'); return; }
    // Volume coverage: candles with actual trading activity
    const withVolume = recent.filter(c => c.volume > 0).length;
    const volumeRatio = withVolume / count;
    // Gap analysis: find max consecutive gap
    let maxGapMs = 0;
    for (let i = 1; i < recent.length; i++) {
      const g = recent[i].timestamp - recent[i - 1].timestamp;
      if (g > maxGapMs) maxGapMs = g;
    }
    const oneDayMs = 86_400_000;
    // Sparse: few candles, poor volume coverage, or a gap > 1 day in recent history
    const isSparse = count < 20 || volumeRatio < 0.3 || (count < 50 && maxGapMs > oneDayMs);
    setMode(isSparse ? 'candlestick' : 'area');
  }, [hasData, tokenMint]);

  // Reset viewport + crosshair when token or timeframe changes.
  // loadData is removed — useRealtimeChart handles data fetching.
  useEffect(() => {
    setCrosshair(null);
    animEngine.actions.returnToLive();
    priceScaleKeyRef.current = '';
    hasAutoScrolledRef.current = false;
    userPannedRef.current = false;
    latestPriceTsRef.current = 0;
  }, [tokenMint, timeframe]);

  useEffect(() => { setCrosshair(null); }, [mode]);

  // Connect WebSocket once pair address is resolved
  useEffect(() => {
    if (!resolvedPairAddr) return;
    connectWebSocket(resolvedPairAddr);
    return () => {
      if (wsDebounceRef.current) { clearTimeout(wsDebounceRef.current); wsDebounceRef.current = null; }
      if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
      wsRetryCountRef.current = 0;
      if (wsRef.current) {
        wsRef.current.onclose = null; wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      setWsConnected(false);
    };
  }, [resolvedPairAddr]);

  // REST price backup — 10s interval. Only updates if newer than last accepted price.
  useEffect(() => {
    if (!tokenMint) return;
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    const fetchPrice = async () => {
      // Skip REST polling when a real-time source (WS, liveTokenStore, Helius)
      // already provided a fresh price in the last 7 seconds — avoids stale
      // REST responses overwriting live prices and reduces mobile CPU usage.
      if (Date.now() - latestPriceTsRef.current < 7000) return;
      const startTs = Date.now();
      // Primary: Jupiter Price API
      try {
        const jupRes = await fetch(
          `https://api.jup.ag/price/v2?ids=${tokenMint}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (jupRes.ok) {
          const jupData = await jupRes.json();
          const jupPrice = Number(jupData?.data?.[tokenMint!]?.price ?? 0);
          // Jupiter REST is a quote-only price — not a real trade event.
          if (jupPrice > 0) { applyLivePrice(jupPrice, startTs, false); return; }
        }
      } catch {}
      // Fallback: DexScreener REST
      try {
        const pair = pairAddrRef.current;
        const url = pair
          ? `https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`
          : `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const data = await res.json();
        const pairData = data.pair ?? data.pairs?.[0];
        if (!pairData) return;
        const p = parseFloat(pairData.priceUsd || '0');
        // DexScreener REST is a quote-only price — not a real trade event.
        if (p > 0) applyLivePrice(p, startTs, false);
      } catch {}
    };

    const firstPoll = setTimeout(fetchPrice, 1500);
    // Poll every 10s — less aggressive than before, reduces mobile CPU usage
    pollTimerRef.current = setInterval(fetchPrice, 10_000);
    return () => {
      clearTimeout(firstPoll);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [tokenMint, applyLivePrice]);

  // External price from parent tokenInfo — lower priority than WS, higher than nothing
  useEffect(() => {
    const externalPrice = resolvedInfo?.price;
    if (!externalPrice || externalPrice <= 0) return;
    if (externalPrice === prevExternalPriceRef.current) return;
    prevExternalPriceRef.current = externalPrice;
    // External price from parent is a snapshot/API value — not a real trade event.
    applyLivePrice(externalPrice, Date.now() - 2000, false);
  }, [resolvedInfo?.price, applyLivePrice]);

  // liveTokenStore subscription — pushed by other parts of the app.
  // fromStoreRef prevents applyLivePrice from pushing right back into the store.
  useEffect(() => {
    if (!tokenMint) return;
    const unsub = liveTokenStore.watch(tokenMint, (state) => {
      if (state.price > 0) {
        fromStoreRef.current = true;
        applyLivePrice(state.price, state.lastUpdatedAt, false);
        fromStoreRef.current = false;
      }
      // Capture 24h change from store — refreshed every 30s by DexScreener polls.
      if (state.priceChange24h !== 0) {
        setLive24hChange(state.priceChange24h);
      }
    });
    return unsub;
  }, [tokenMint, applyLivePrice]);

  // Supabase realtime for live trades is now handled by useRealtimeChart.
  // That hook opens a direct channel per (mint, timeframe) accepting all
  // is_live=true rows (not restricted to timeframe='1m') so charts on every
  // timeframe get immediate updates when Helius writes a new candle.

  // IMPORTANT: no automatic pan correction after data loads.
  useEffect(() => {
    hasAutoScrolledRef.current = true;
  }, [tokenMint, timeframe]);

  // ── chart geometry ────────────────────────────────────────────────────────
  // MCAP scale: token supply frozen once per token so MCAP never drifts with quote prices.
  // Priority: 1) real totalSupply from caller  2) derived snapshot  3) live-price derivation.
  // All display surfaces (header, axis, live pill, crosshair) multiply by the same supply.
  {
    if (stableSupplyRef.current === null) {
      const ts = resolvedInfo?.totalSupply;
      const sp = resolvedInfo?.price;
      const sm = resolvedInfo?.marketCap;
      // Prefer the snapshot marketCap/price ratio when both exist. Some token APIs
      // return misleading totalSupply values for pump/sparse tokens, which can make
      // chart MCAP explode into billions. The snapshot ratio keeps header, axis and
      // price pill consistent with the token card.
      if (sp && sp > 0 && sm && sm > 0) {
        stableSupplyRef.current = sm / sp;
      } else if (livePrice && livePrice > 0 && sm && sm > 0) {
        stableSupplyRef.current = sm / livePrice;
      } else if (ts && ts > 0) {
        stableSupplyRef.current = ts;
      }
    }
  }
  const mcapScale = valueMode === 'mcap' && stableSupplyRef.current != null
    ? stableSupplyRef.current
    : 1;

  const plotW = chartWidth - PAD.left - PAD.right;
  plotWRef.current = plotW;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const plotHRef = useRef(plotH);
  plotHRef.current = plotH;

  // ── Live time geometry ────────────────────────────────────────────────────
  // ALL mode: use the resolution that was actually fetched (allEffectiveTf),
  // not the hardcoded BUCKET_MS['ALL'] = 1D. Without this fix, 1H candles
  // all collapse to the same x-position (12h offset each), creating vertical walls.
  const bucketMs       = timeframe === 'ALL'
    ? (BUCKET_MS[allEffectiveTf] ?? 3_600_000)
    : (BUCKET_MS[timeframe] ?? 3_600_000);
  const visibleBuckets = VISIBLE_BUCKETS[timeframe] ?? 48;
  // panOffsetCandles derived from engine for all downstream consumers.
  const panOffsetCandles = bucketMs > 0 ? animEngine.state.panOffsetMs / bucketMs : 0;
  let rightTime          = animEngine.state.visualRightTime - animEngine.state.panOffsetMs;
  const visibleMs        = visibleBuckets * bucketMs;
  let leftTime           = rightTime - visibleMs;
  bucketMsRef.current    = bucketMs;

  // Merge real historical candles + active live candle at render time.
  // Real candles are immutable; only the active live candle updates on price change.
  const mergedCandles = useMemo(() => {
    // `candles` state is always produced by sanitizeRawCandles inside loadData —
    // applying filterValidCandles a second time would create two competing validation
    // systems and could silently reject valid flat-doji candles (open=high=low=close).
    // Single validation pass: use candles directly.
    const deduped = dedupByBucket(candles, bucketMs);
    if (!activeLiveCandle) return deduped;
    const liveB = Math.floor(activeLiveCandle.timestamp / bucketMs) * bucketMs;
    // Remove any historical candle in the same bucket (live price owns that bucket)
    const withoutSameBucket = deduped.filter(
      c => Math.floor(c.timestamp / bucketMs) * bucketMs !== liveB
    );
    return [...withoutSameBucket, activeLiveCandle].sort((a, b) => a.timestamp - b.timestamp);
  }, [candles, activeLiveCandle, bucketMs]);

  // ── Unified viewport + visible candles ─────────────────────────────────────
  // IMPORTANT:
  // The x-window is computed ONCE from the animation engine and the full real
  // candle history. Line, area, candles, bars, volume and time labels all share
  // this exact same xLeft/xVisibleMs. This prevents the old bugs where:
  //   - the line folded back on itself,
  //   - volume bars appeared detached or stuck on the left,
  //   - scroll snapped back because xLeft was reclamped from only the currently
  //     visible subset,
  //   - the latest dot became a separate element.
  //
  // No fake candles, no fake volume and no data mutation are created here.
  let xLeft      = rightTime - visibleMs;
  let xVisibleMs = visibleMs;

  if (mergedCandles.length > 0) {
    const firstHistoryTs = mergedCandles[0].timestamp;
    const lastHistoryTs  = mergedCandles[mergedCandles.length - 1].timestamp;

    const leftPadMs  = Math.max(bucketMs * 1.5, visibleMs * 0.025);
    const rightPadMs = Math.min(Math.max(bucketMs * 2.5, visibleMs * 0.08), visibleMs * 0.16);

    const minLeft = firstHistoryTs - leftPadMs;

    // For sparse tokens (few candles relative to the visible window), shrink the window
    // so candles fill at least 60% of the chart width instead of clustering on the left.
    // Only applies in live mode and only when the candle span is much shorter than visibleMs.
    const candleSpan = lastHistoryTs - firstHistoryTs;
    const sparseLiveVisibleMs = (panOffsetCandles === 0 && candleSpan > 0 && candleSpan < visibleMs * 0.4)
      ? Math.max(bucketMs * Math.max(mergedCandles.length + 4, 8), candleSpan * 1.6 + rightPadMs)
      : visibleMs;

    const effectiveVisibleMs = Math.min(visibleMs, sparseLiveVisibleMs);
    const liveLeft = Math.max(minLeft, rightTime - effectiveVisibleMs);
    const maxLeft = liveLeft;

    if (panOffsetCandles === 0) {
      xLeft = liveLeft;
      xVisibleMs = rightTime - xLeft;
    } else {
      // User pan: fixed-width viewport translation only.
      // Always use the full visibleMs window so the user can scroll freely back through history.
      xLeft = Math.max(minLeft, rightTime - visibleMs);
      xVisibleMs = visibleMs;
    }
  }

  leftTime  = xLeft;
  rightTime = xLeft + xVisibleMs;
  leftTimeRef.current  = xLeft;
  visibleMsRef.current = xVisibleMs;

  const MIN_LIVE_CANDLES = 6;
  const visibleWindowStart = xLeft - bucketMs;
  const visibleWindowEnd   = xLeft + xVisibleMs + bucketMs;

  let filledRaw = mergedCandles.filter(c =>
    c.timestamp >= visibleWindowStart && c.timestamp <= visibleWindowEnd
  );

  // If no real candle is inside the current live window, do not move xLeft back
  // and do not inject old candles into the current viewport. A flat display-only
  // last-price guide is rendered below so the chart is not empty, while the time
  // axis can still move continuously.

  // Apply MCAP scale for rendering.
  // When a token has a valid live/snapshot price but no OHLCV candles on the selected
  // timeframe, keep the chart usable by drawing a zero-volume visual price guide.
  // This is display-only spacing: it is not saved to state, not treated as a trade,
  // not counted as volume, and not used as historical activity.
  const renderGuidePrice = activeLiveCandle
    ? activeLiveCandle.close
    : mergedCandles.length > 0
      ? mergedCandles[mergedCandles.length - 1].close
      : livePrice && livePrice > 0
        ? livePrice
        : currentPrice && currentPrice > 0
          ? currentPrice
          : resolvedInfo?.price && resolvedInfo.price > 0
            ? resolvedInfo.price
            : 0;

  const hasRealRenderCandles = filledRaw.length > 0;

  // Do NOT create a fake two-point guide line when no real candle is visible.
  // The price guide/pill can still show the current value, but the plotted line,
  // area, candles and volume must come only from real OHLCV candles.
  const renderRaw = hasRealRenderCandles ? filledRaw : [];
  const isVisualGuideOnly = false;

  // Normalize candle unit before display.
  // Some upstream APIs occasionally return OHLCV values in a wrong unit/mcap-like
  // magnitude while the token header has the correct live price. We preserve the
  // real candle SHAPE, but anchor the last candle to the live/snapshot price so
  // PRICE mode cannot show values like $179B for a $0.0002 token.
  const quoteAnchorPrice = livePrice && livePrice > 0
    ? livePrice
    : currentPrice && currentPrice > 0
      ? currentPrice
      : resolvedInfo?.price && resolvedInfo.price > 0
        ? resolvedInfo.price
        : 0;
  const rawLastCloseForUnit = renderRaw.length > 0
    ? renderRaw[renderRaw.length - 1].close
    : renderGuidePrice;
  const rawToPriceRatio = quoteAnchorPrice > 0 && rawLastCloseForUnit > 0
    ? rawLastCloseForUnit / quoteAnchorPrice
    : 1;
  const candleToPriceScale = rawToPriceRatio > 1000 || rawToPriceRatio < 0.001
    ? quoteAnchorPrice / rawLastCloseForUnit
    : 1;
  const normalizedPriceRaw = candleToPriceScale !== 1
    ? renderRaw.map(c => ({
        ...c,
        open:  c.open  * candleToPriceScale,
        high:  c.high  * candleToPriceScale,
        low:   c.low   * candleToPriceScale,
        close: c.close * candleToPriceScale,
      }))
    : renderRaw;

  const displayScale = valueMode === 'mcap' ? mcapScale : 1;
  const displayCandles = displayScale !== 1
    ? normalizedPriceRaw.map(c => ({
        ...c,
        open:  c.open  * displayScale,
        high:  c.high  * displayScale,
        low:   c.low   * displayScale,
        close: c.close * displayScale,
      }))
    : normalizedPriceRaw;

  displayCandlesRef.current = displayCandles;
  const n = displayCandles.length;

  // ── Stable price scale ────────────────────────────────────────────────────
  // Keyed on visible window boundaries and visible min/max so scale fits exactly
  // what's on screen when panning. Live spike expands scale in-place.
  {
    const dcLen   = displayCandles.length;
    const dcFirst = displayCandles[0];
    const dcLast  = displayCandles[dcLen - 1];
    // Restrict to visible window for scale computation — use xLeft (post-adjustment)
    // so the Y scale matches exactly what is rendered, not the wider raw time window.
    const visibleOnly = displayCandles.filter(
      c => c.timestamp >= xLeft && c.timestamp <= xLeft + xVisibleMs
    );
    const scaleBase   = visibleOnly.length > 0 ? visibleOnly : displayCandles;
    // Real candles (volume > 0) take priority for scale; zero-volume live/visual guide candles expands it
    const realVisible = scaleBase.filter(c => c.volume > 0);
    const scaleSource = realVisible.length > 0 ? realVisible : scaleBase;
    const visMinLow  = scaleSource.length > 0 ? Math.min(...scaleSource.map(c => c.low))  : 0;
    const visMaxHigh = scaleSource.length > 0 ? Math.max(...scaleSource.map(c => c.high)) : 1;

    const key = [
      timeframe, valueMode, panOffsetCandles,
      dcLen,
      dcFirst?.timestamp ?? 0, dcLast?.timestamp ?? 0,
      // Use bucket-level granularity, NOT 1-second. The animation engine advances
      // xLeft every RAF tick (real-clock speed); using /1000 here caused the scale key
      // to change every second and triggered a full Y-axis recalculation on every frame,
      // producing the "sliding/backward" visual artifact. Bucket-level means the scale
      // only recomputes when the viewport has actually moved by a full candle width.
      Math.round(xLeft / bucketMs), Math.round(rightTime / bucketMs),
      visMinLow.toPrecision(4), visMaxHigh.toPrecision(4),
    ].join('|');

    if (key !== priceScaleKeyRef.current && displayCandles.length > 0) {
      priceScaleKeyRef.current = key;
      const safeMax  = isFinite(visMaxHigh) && visMaxHigh > 0 ? visMaxHigh : 1;
      const safeMin  = isFinite(visMinLow)  && visMinLow  >= 0 ? visMinLow : 0;
      const range    = (safeMax - safeMin) || safeMax * 0.02 || 0.001;
      // Very sparse tokens (<5 visible candles) need a minimum 4% padding so the
      // Y-axis never collapses to an unreadable ultra-tight band (e.g. $5.370K–$5.390K).
      // This places the candle(s) at the vertical center with meaningful axis labels.
      const minPadFraction = scaleSource.length < 5 ? 0.04 : 0;
      const pad = Math.max(range * 0.15, safeMax * minPadFraction);
      // Volume scale from visible real candles only; zero-volume entries ignored
      const realVols   = scaleBase.filter(c => c.volume > 0).map(c => c.volume);
      const sortedVols = [...realVols].sort((a, b) => a - b);
      const p90idx     = Math.min(Math.floor(sortedVols.length * 0.9), sortedVols.length - 1);
      const cappedVol  = sortedVols.length > 0 ? Math.max(sortedVols[p90idx] * 1.5, 1) : 1;
      // Use a tight scale: start just below the lowest visible candle.
      // Only force minP=0 when data goes near 0 (bottom < 10% of top),
      // preventing the "scaled from $0 to huge value" axis artifact.
      const tightMin     = safeMin - pad;
      const includeZero  = tightMin < 0 || safeMin < safeMax * 0.08;
      const safeMinP     = includeZero ? Math.max(0, tightMin) : tightMin;
      priceScaleRef.current = {
        maxP:       safeMax + pad,
        minP:       safeMinP,
        priceRange: (safeMax + pad) - safeMinP || 1,
        maxVol:     cappedVol,
      };
    }

    // Expand scale in-place only when live candle exceeds bounds
    const liveC = n > 0 ? displayCandles[n - 1] : null;
    if (liveC) {
      const { maxP: cMax, minP: cMin, maxVol } = priceScaleRef.current;
      const liveHigh = isFinite(liveC.high) && liveC.high > 0 ? liveC.high : 0;
      const liveLow  = isFinite(liveC.low)  && liveC.low  > 0 ? liveC.low  : cMin;
      if (liveHigh > cMax || liveLow < cMin) {
        const newMax = Math.max(cMax, liveHigh * 1.05);
        const newMin = Math.max(0, Math.min(cMin, liveLow * 0.95));
        priceScaleRef.current = { maxP: newMax, minP: newMin, priceRange: (newMax - newMin) || 1, maxVol };
      }
    }
  }
  const { maxP, minP, priceRange, maxVol } = priceScaleRef.current;
  // slotW: pixel-width of one candle slot.
  // For ALL mode we base it on the actual candle count so candles don't collide.
  // For other modes we use the target density (visibleBuckets) to keep widths stable.
  const effectiveBuckets = visibleBuckets;
  const slotW = plotW / effectiveBuckets;
  const MAX_CANDLE_W = isMobile ? 16 : 12;
  const MAX_BAR_W    = isMobile ?  7 :  6;
  // Body/tick widths derived from slotW so they never widen due to sparse data
  // Very sparse tokens (1-4 candles): use wider bodies so isolated candles are readable.
  const _vSparse = n > 0 && n < 5;
  const isOneMinuteTf = timeframe === '1m' || timeframe === '1s';
  const isFiveMinuteTf = timeframe === '5m';
  const isShortTf = isOneMinuteTf || isFiveMinuteTf;
  const barW    = Math.min(MAX_BAR_W,    Math.max(isMobile ? 2.5 : 2, slotW * (_vSparse ? 0.60 : 0.42)));
  const minCandleW = isMobile
    ? (isOneMinuteTf ? 6 : isFiveMinuteTf ? 5 : (_vSparse ? 7 : 4))
    : (isOneMinuteTf ? 5 : isFiveMinuteTf ? 4 : (_vSparse ? 6 : 3));
  const candleW = Math.min(MAX_CANDLE_W, Math.max(minCandleW, slotW * (isMobile ? (_vSparse ? 0.82 : 0.68) : (_vSparse ? 0.72 : 0.62))));

  function tsToX(ts: number): number {
    return PAD.left + ((ts - xLeft) / xVisibleMs) * plotW;
  }

  function xOf(i: number): number {
    const c = displayCandles[i];
    if (!c) return PAD.left + (i + 0.5) * (plotW / Math.max(n, 1));
    // Single source of truth for X positioning. Every visual layer uses the same
    // timestamp → x mapping. Do not cap only the latest candle/dot here; capping
    // created folded segments and de-synced volume bars from the line.
    return tsToX(c.timestamp + bucketMs / 2);
  }
  function yOf(price: number) {
    const raw = PAD.top + plotH - ((price - minP) / priceRange) * plotH;
    return Math.max(PAD.top, Math.min(PAD.top + plotH, raw));
  }
  const volumeTopY = CHART_H + 6;
  const volumeAreaH = Math.max(10, VOL_H - 12);
  const timeAxisTopY = CHART_H + VOL_H;
  function volBarH(vol: number): number {
    if (vol <= 0 || !isFinite(vol) || maxVol <= 0) return 0;
    const h = (vol / maxVol) * volumeAreaH;
    // No hard minimum — micro-volume proportionally tiny (< 0.3px) renders as nothing.
    // Only apply 1px floor once the bar is visually meaningful (≥0.3px proportional height).
    return h < 0.3 ? 0 : Math.max(1, h);
  }

  const totalH = CHART_H + VOL_H + TIME_H;

  // ── Crosshair + pan responder ─────────────────────────────────────────────
  const updateCrosshairAt = (localX: number, _localY: number) => {
    const cands = displayCandlesRef.current;
    if (!cands.length) return;
    const pw  = plotWRef.current;
    const lt  = leftTimeRef.current;
    const vm  = visibleMsRef.current;
    const bm  = bucketMsRef.current;
    const rawTs = lt + ((localX - PAD.left) / pw) * vm;
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const d = Math.abs(cands[i].timestamp + bm / 2 - rawTs);
      if (d < closestDist) { closestDist = d; closestIdx = i; }
    }
    const c  = cands[closestIdx];
    const cx = PAD.left + ((c.timestamp + bm / 2 - lt) / vm) * pw;
    const { minP: scaleMin, priceRange: scaleRange } = priceScaleRef.current;
    const ph     = plotHRef.current;
    const rawCy  = PAD.top + ph - ((c.close - scaleMin) / scaleRange) * ph;
    const cy     = Math.max(PAD.top, Math.min(PAD.top + ph, rawCy));
    const firstClose = cands[0].close;
    const pct    = firstClose > 0 ? ((c.close - firstClose) / firstClose) * 100 : 0;
    setCrosshair({ x: cx, y: cy, idx: closestIdx, price: c.close, ts: c.timestamp, pct });
  };

  const applyTouchToCrosshair = (pageX: number, pageY: number) => {
    if (Platform.OS === 'web') {
      const webEl = svgContainerRef.current as any;
      if (webEl?.getBoundingClientRect) {
        const rect = webEl.getBoundingClientRect();
        svgOffsetRef.current = { x: rect.left, y: rect.top };
      }
      updateCrosshairAt(pageX - svgOffsetRef.current.x, pageY - svgOffsetRef.current.y);
    } else {
      svgContainerRef.current?.measure((_fx, _fy, _w, _h, px, py) => {
        svgOffsetRef.current = { x: px, y: py };
        updateCrosshairAt(pageX - px, pageY - py);
      });
    }
  };

  // ── Web mouse drag state ─────────────────────────────────────────────────
  const mouseDragRef         = useRef(false);
  const mouseDragStartXRef   = useRef(0);
  const mousePanStartRef     = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      // Do NOT grab on start — let the move threshold decide.
      // This ensures vertical swipes pass through to page scroll unobstructed.
      onStartShouldSetPanResponder: () => false,
      // Grab only when the gesture is clearly horizontal.
      onMoveShouldSetPanResponder: (_e, gs) => {
        const adx = Math.abs(gs.dx);
        const ady = Math.abs(gs.dy);
        return adx > 8 && adx > ady * 1.8;
      },

      onPanResponderGrant: (e) => {
        panStartOffsetMsRef.current = currentPanOffsetMsRef.current;
        gestureModeRef.current      = 'pan';
        animEngine.actions.onPanStart();
        touchStartXRef.current    = e.nativeEvent.pageX;
        touchStartYRef.current    = e.nativeEvent.pageY;
        touchStartTimeRef.current = Date.now();
        setCrosshair(null);
      },

      onPanResponderMove: (_e, gestureState) => {
        if (gestureModeRef.current !== 'pan') return;
        userPannedRef.current = true;
        const pw = plotWRef.current || 1;
        // Drag left (negative dx) = newer/live (offset decreases); drag right = older history (offset increases).
        const deltaMsFromStart = (gestureState.dx / pw) * visibleMsRef.current;
        const newOffsetMs = Math.max(0, panStartOffsetMsRef.current + deltaMsFromStart);
        animEngine.actions.setPanOffsetMs(newOffsetMs);
      },

      onPanResponderRelease: (e) => {
        animEngine.actions.onPanEnd();
        const totalMovement = Math.hypot(
          e.nativeEvent.pageX - touchStartXRef.current,
          e.nativeEvent.pageY - touchStartYRef.current,
        );
        const elapsed = Date.now() - touchStartTimeRef.current;
        // A short tap (< 300ms, < 10px movement) with no committed pan = show crosshair.
        if (gestureModeRef.current !== 'pan' || (totalMovement < 10 && elapsed < 300)) {
          applyTouchToCrosshair(e.nativeEvent.pageX, e.nativeEvent.pageY);
        }
        gestureModeRef.current = 'idle';
      },

      onPanResponderTerminate: () => {
        animEngine.actions.onPanEnd();
        gestureModeRef.current = 'idle';
      },
    })
  ).current;

  // Web-only touch start ref for horizontal swipe detection
  const webTouchStartXRef = useRef(0);
  const webTouchStartYRef = useRef(0);

  const webMouseHandlers = Platform.OS === 'web' ? {
    // Capture horizontal swipes inside the chart so the browser never sees them as
    // navigation gestures (back/forward). We use pan-y touchAction on the container
    // so vertical scroll still works, but for clearly horizontal drags we must call
    // preventDefault so the browser back gesture is never triggered.
    onTouchStart: (e: any) => {
      const t = e.touches?.[0];
      if (t) { webTouchStartXRef.current = t.clientX; webTouchStartYRef.current = t.clientY; }
    },
    onTouchMove: (e: any) => {
      const t = e.touches?.[0];
      if (!t) return;
      const adx = Math.abs(t.clientX - webTouchStartXRef.current);
      const ady = Math.abs(t.clientY - webTouchStartYRef.current);
      // If clearly horizontal (2:1 ratio) prevent browser back/forward navigation
      if (adx > 8 && adx > ady * 2) {
        e.preventDefault?.();
      }
    },
    onMouseMove: (e: any) => {
      if (mouseDragRef.current) {
        userPannedRef.current = true;
        const pw = plotWRef.current || 1;
        const dx = e.clientX - mouseDragStartXRef.current;
        // Drag left (negative dx) = newer/live (offset decreases); drag right = older history (offset increases).
        const deltaMsFromStart = (dx / pw) * visibleMsRef.current;
        const newOffsetMs = Math.max(0, mousePanStartRef.current + deltaMsFromStart);
        animEngine.actions.setPanOffsetMs(newOffsetMs);
        setCrosshair(null);
      } else {
        const rect = e.currentTarget?.getBoundingClientRect?.();
        if (!rect) return;
        updateCrosshairAt(e.clientX - rect.left, e.clientY - rect.top);
      }
    },
    onMouseDown: (e: any) => {
      mouseDragRef.current       = true;
      mouseDragStartXRef.current = e.clientX;
      mousePanStartRef.current   = currentPanOffsetMsRef.current;
      animEngine.actions.onPanStart();
      e.preventDefault();
    },
    onMouseUp: (_e: any) => {
      mouseDragRef.current = false;
      animEngine.actions.onPanEnd();
    },
    onMouseLeave: (_e: any) => {
      mouseDragRef.current = false;
      animEngine.actions.onPanEnd();
    },
    onWheel: (e: any) => {
      e.preventDefault();
      const pw = plotWRef.current || 1;
      // Horizontal scroll or shift+wheel scrolls the chart timeline.
      // Vertical scroll (without shift) also scrolls the chart.
      const deltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const scrollMs = (deltaX / pw) * visibleMsRef.current;
      const newOffset = Math.max(0, currentPanOffsetMsRef.current + scrollMs);
      userPannedRef.current = newOffset > 0;
      animEngine.actions.setPanOffsetMs(newOffset);
    },
    onContextMenu: (e: any) => e.preventDefault(),
  } : {};

  const dismissCrosshair = () => setCrosshair(null);

  // ── Derived display values ────────────────────────────────────────────────
  const sym               = resolvedInfo?.symbol ?? 'TOKEN';
  const contractAddr      = resolvedInfo?.address ?? tokenMint ?? '';
  const shortContractAddr = contractAddr ? `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}` : '';

  // Latest price: use interpolated price when in live mode (smoothly animated),
  // then fall back to hook livePrice, last candle close, then external prop.
  const latestClose      = normalizedPriceRaw.length > 0
    ? normalizedPriceRaw[normalizedPriceRaw.length - 1].close
    : (quoteAnchorPrice > 0 ? quoteAnchorPrice : 0);
  const displayPriceVal  = (interpP != null && interpP > 0 && animEngine.state.isLiveMode) ? interpP
    : (livePrice != null && livePrice > 0) ? livePrice
    : latestClose > 0 ? latestClose
    : (currentPrice != null && currentPrice > 0 ? currentPrice : 0);

  // Header always shows actual marketCap from snapshot (no stale scale multiplication).
  // Axis labels use mcapScale for consistency.
  const mcapVal = resolvedInfo?.marketCap ?? null;
  // 24h change: prefer live value from store (refreshed every 30s); fall back to snapshot.
  // Validate: reject values outside ±999% as they indicate stale/bad data from the source.
  // Show "—" when neither source has a real non-zero validated value.
  const raw24h  = resolvedInfo?.priceChange24h;
  const is24hValid = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined && isFinite(v) && Math.abs(v) <= 999;
  const change24h = is24hValid(live24hChange) ? live24hChange
    : is24hValid(raw24h) ? raw24h : 0;
  const has24h = is24hValid(live24hChange) || (is24hValid(raw24h) && raw24h !== 0);
  const isUp       = change24h >= 0;
  const changeColor = isUp ? '#10B981' : '#EC4899';
  // Guide-anchored price: same source as the chart guide line.
  // In MCAP mode the header uses this so header and guide never contradict each other.
  // In price mode the header uses the live quote price (quote display is acceptable).
  const realAnchoredPrice = latestClose > 0 ? latestClose : displayPriceVal;
  // MCAP mode: multiply real candle price by stable supply (same as guide + axis).
  // Price mode: show live quote price directly.
  const liveScaledValue = valueMode === 'mcap'
    ? realAnchoredPrice * mcapScale
    : displayPriceVal;
  const headerValue = valueMode === 'mcap'
    ? fmtMcap(mcapVal && mcapVal > 0 ? mcapVal : liveScaledValue)
    : `$${fmtPrice(displayPriceVal)}`;

  const currentModeConfig = CHART_MODES.find(m => m.key === mode) ?? CHART_MODES[0];
  const ModeIcon = currentModeConfig.icon;

  const handleCopyAddr = async () => {
    if (!contractAddr) return;
    await Clipboard.setStringAsync(contractAddr);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  };

  // Opens DAWEN's internal TradingView-style chart.
  // It stays inside the app and uses the same existing token data sources.
  const handleOpenTradingView = () => {
    setShowProChart(true);
  };

  // ── Chart header ──────────────────────────────────────────────────────────
  const header = (
    <View style={[styles.chartHeader, hideTokenHeader && styles.chartHeaderSlim]}>
      {!hideTokenHeader && <View style={styles.tokenInfoRow}>
        {resolvedInfo?.image ? (
          <Image source={{ uri: resolvedInfo.image }} style={styles.tokenLogoLg} />
        ) : (
          <View style={styles.tokenLogoLgFallback}>
            <Text style={styles.tokenLogoLgText}>{sym.slice(0, 2).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.tokenInfoMid}>
          <View style={styles.tokenNameRow}>
            <Text style={styles.tokenNameText} numberOfLines={1}>{resolvedInfo?.name ?? sym}</Text>
            {wsConnected && (
              <Animated.View style={[styles.liveWsDot, { transform: [{ scale: headerPulseAnim }] }]} />
            )}
          </View>
          {shortContractAddr ? (
            <TouchableOpacity style={styles.addrRow} onPress={handleCopyAddr} activeOpacity={0.7}>
              <Text style={styles.addrText}>{shortContractAddr}</Text>
              {copiedAddr
                ? <CheckCircle2 size={10} color={colors.success} strokeWidth={2} />
                : <Copy size={10} color="rgba(255,255,255,0.35)" strokeWidth={2} />}
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.tokenPriceRight}>
          <TouchableOpacity onPress={() => setValueMode(valueMode === 'mcap' ? 'price' : 'mcap')} activeOpacity={0.8}>
            <Text style={styles.tokenBigPrice}>{headerValue}</Text>
          </TouchableOpacity>
          <View style={styles.tokenChangeRow}>
            {has24h ? (
              <>
                {isUp
                  ? <TrendingUp  size={11} color={changeColor} strokeWidth={2.5} />
                  : <TrendingDown size={11} color={changeColor} strokeWidth={2.5} />}
                <Text style={[styles.tokenChangePct, { color: changeColor }]}>
                  {isUp ? '+' : ''}{change24h.toFixed(2)}%
                </Text>
              </>
            ) : (
              <Text style={[styles.tokenChangePct, { color: 'rgba(255,255,255,0.3)' }]}>—</Text>
            )}
          </View>
        </View>
      </View>}

      <View style={styles.tfControlRow}>
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          style={styles.tfScroll} contentContainerStyle={styles.tfScrollContent}>
          {ALL_TIMEFRAMES.map(tf => (
            <TouchableOpacity
              key={tf.key}
              style={[styles.tfPill, timeframe === tf.key && styles.tfPillActive]}
              onPress={() => setTimeframe(tf.key)}
              activeOpacity={0.7}>
              <Text style={[styles.tfPillText, timeframe === tf.key && styles.tfPillTextActive]}>
                {tf.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={styles.chartCtrlBtns}>
          <TouchableOpacity
            style={styles.tradingViewBtn}
            onPress={handleOpenTradingView}
            activeOpacity={0.8}>
            <Text style={styles.tradingViewBtnText}>TV</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.chartCtrlBtn, showModePanel && styles.chartCtrlBtnActive]}
            onPress={() => { setShowModePanel(p => !p); setShowSettingsPanel(false); }}
            activeOpacity={0.8}>
            <ModeIcon size={15} color={showModePanel ? '#A78BFA' : 'rgba(255,255,255,0.6)'} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.chartCtrlBtn, showSettingsPanel && styles.chartCtrlBtnActive]}
            onPress={() => { setShowSettingsPanel(p => !p); setShowModePanel(false); }}
            activeOpacity={0.8}>
            <SlidersHorizontal size={15} color={showSettingsPanel ? '#A78BFA' : 'rgba(255,255,255,0.6)'} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {showModePanel && (
        <View style={styles.modePanelRow}>
          {CHART_MODES.map(m => {
            const IconComp = m.icon;
            const active   = mode === m.key;
            return (
              <TouchableOpacity
                key={m.key}
                style={[styles.modePanelItem, active && styles.modePanelItemActive]}
                onPress={() => { userSelectedModeRef.current = true; setMode(m.key); setShowModePanel(false); }}
                activeOpacity={0.75}>
                <IconComp size={14} color={active ? '#fff' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2.5 : 2} />
                <Text style={[styles.modePanelLabel, active && styles.modePanelLabelActive]}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {showSettingsPanel && (
        <View style={styles.settingsPanel}>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Display</Text>
            <View style={styles.settingsToggleGroup}>
              <TouchableOpacity
                style={[styles.settingsToggleBtn, valueMode === 'mcap' && styles.settingsToggleBtnActive]}
                onPress={() => setValueMode('mcap')} activeOpacity={0.75}>
                <Text style={[styles.settingsToggleText, valueMode === 'mcap' && styles.settingsToggleTextActive]}>MCAP</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.settingsToggleBtn, valueMode === 'price' && styles.settingsToggleBtnActive]}
                onPress={() => setValueMode('price')} activeOpacity={0.75}>
                <Text style={[styles.settingsToggleText, valueMode === 'price' && styles.settingsToggleTextActive]}>PRICE</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Volume bars</Text>
            <TouchableOpacity style={[styles.settingsSwitch, showVolume && styles.settingsSwitchOn]}
              onPress={() => setShowVolume(v => !v)} activeOpacity={0.75}>
              <View style={[styles.settingsSwitchThumb, showVolume && styles.settingsSwitchThumbOn]} />
            </TouchableOpacity>
          </View>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Price guide</Text>
            <TouchableOpacity style={[styles.settingsSwitch, showPriceLine && styles.settingsSwitchOn]}
              onPress={() => setShowPriceLine(v => !v)} activeOpacity={0.75}>
              <View style={[styles.settingsSwitchThumb, showPriceLine && styles.settingsSwitchThumbOn]} />
            </TouchableOpacity>
          </View>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Grid lines</Text>
            <TouchableOpacity style={[styles.settingsSwitch, showGrid && styles.settingsSwitchOn]}
              onPress={() => setShowGrid(v => !v)} activeOpacity={0.75}>
              <View style={[styles.settingsSwitchThumb, showGrid && styles.settingsSwitchThumbOn]} />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );

  const autoScrollPending = !hasAutoScrolledRef.current && candles.length > 0 && displayCandles.length === 0;
  const isFirstLoad = ((loading && candles.length === 0 && displayPriceVal <= 0) || autoScrollPending);

  if (isFirstLoad) {
    return (
      <View style={styles.container}>
        {header}
        <View style={[styles.loadingWrap, { height: CHART_H }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.loadingSubText}>Loading chart…</Text>
        </View>
      </View>
    );
  }

  if (!hasData && candles.length === 0 && displayPriceVal <= 0) {
    return (
      <View style={styles.container}>
        {header}
        <View style={[styles.unavailableWrap, { height: CHART_H }]}>
          {displayPriceVal > 0 ? (
            <>
              <Text style={styles.priceFallback}>{fmtValue(valueMode === 'mcap' ? (mcapVal ?? displayPriceVal * mcapScale) : displayPriceVal, valueMode)}</Text>
              <Text style={styles.unavailableText}>Price unavailable</Text>
            </>
          ) : (
            <Text style={styles.unavailableText}>Chart temporarily unavailable</Text>
          )}
        </View>
      </View>
    );
  }

  if (n === 0 && displayPriceVal <= 0) {
    return (
      <View style={styles.container}>
        {header}
        <View style={[styles.unavailableWrap, { height: CHART_H }]}>
          {displayPriceVal > 0 ? (
            <>
              <Text style={styles.priceFallback}>{fmtValue(valueMode === 'mcap' ? (mcapVal ?? displayPriceVal * mcapScale) : displayPriceVal, valueMode)}</Text>
              <Text style={styles.unavailableText}>Loading price…</Text>
            </>
          ) : (
            <ActivityIndicator size="small" color={colors.primary} />
          )}
        </View>
      </View>
    );
  }

  // ── Sparse detection (render-level) ──────────────────────────────────────
  // Computed before segment-building and continuation check so both can use it.
  const _renderSortedGaps = displayCandles
    .slice(1).map((c, i) => c.timestamp - displayCandles[i].timestamp)
    .sort((a, b) => a - b);
  const renderMedianGapMs = _renderSortedGaps.length > 0
    ? _renderSortedGaps[Math.floor(_renderSortedGaps.length / 2)]
    : bucketMs;
  // Flat-doji ratio: repaired candles often have open=high=low=close.
  // A high ratio means most data was repaired/flat — treat as sparse.
  const _flatCount = displayCandles.filter(c =>
    Math.abs(c.high - c.low) < Math.max(c.close, 1e-12) * 1e-6
  ).length;
  const _flatRatio = displayCandles.length > 0 ? _flatCount / displayCandles.length : 0;
  // Sparse when: few candles, wide gaps, OR >50% flat dojis (repaired data).
  const isSparseChart = displayCandles.length < 30 ||
    renderMedianGapMs > bucketMs * 2 ||
    _flatRatio > 0.5;
  // Extremely sparse: 1-4 visible candles — enables extra-visible rendering paths.
  const isVerySparse = n < 5;

  // ── Build paths ───────────────────────────────────────────────────────────
  const bottomY    = (PAD.top + plotH).toFixed(1);
  const plotRightX = PAD.left + plotW;
  const safeRightX = plotRightX - (isMobile ? 34 : 28);
  const isLineVisualMode = mode === 'area' || mode === 'line' || mode === 'mountain' || mode === 'bonding';

  type LinePoint = { x: number; y: number; ts: number; price: number };
  const rawLinePoints: LinePoint[] = displayCandles.map((c, i) => ({
    x: xOf(i),
    y: yOf(c.close),
    ts: c.timestamp + bucketMs / 2,
    price: c.close,
  }));

  // Carry-forward for line/area modes on short timeframes (1m, 5m):
  // When there are no trades in a bucket, instead of lifting the pen and creating a
  // visual gap, keep the last known price flat until the next real trade.
  // This is render-only — no candle data is mutated.
  const baseLinePoints: LinePoint[] = (() => {
    if (!isLineVisualMode || rawLinePoints.length < 2) return rawLinePoints;
    // Only apply on timeframes where empty buckets are common
    if (bucketMs > 5 * 60_000) return rawLinePoints; // only 1s, 1m and 5m
    const filled: LinePoint[] = [];
    for (let i = 0; i < rawLinePoints.length; i++) {
      filled.push(rawLinePoints[i]);
      if (i < rawLinePoints.length - 1) {
        const curr = rawLinePoints[i];
        const next = rawLinePoints[i + 1];
        const gapMs = next.ts - curr.ts;
        // If gap > 1.5× bucketMs, insert carry-forward points at each missing bucket
        if (gapMs > bucketMs * 1.5) {
          const steps = Math.min(Math.floor(gapMs / bucketMs) - 1, 120);
          for (let k = 1; k <= steps; k++) {
            const fillTs = curr.ts + k * bucketMs;
            if (fillTs >= next.ts) break;
            // x position derived from timestamp interpolation
            const fillX = curr.x + (next.x - curr.x) * (k * bucketMs / gapMs);
            filled.push({ x: fillX, y: curr.y, ts: fillTs, price: curr.price });
          }
        }
      }
    }
    return filled;
  })();

  const fallbackGuideValue = valueMode === 'mcap'
    ? (quoteAnchorPrice > 0 ? quoteAnchorPrice * mcapScale : minP)
    : (quoteAnchorPrice > 0 ? quoteAnchorPrice : minP);
  const lastBasePoint = baseLinePoints.length > 0
    ? baseLinePoints[baseLinePoints.length - 1]
    : { x: PAD.left, y: yOf(fallbackGuideValue), ts: xLeft, price: fallbackGuideValue };

  // Live-hold point: extend the line horizontally to the right edge of the price plot.
  // This connects the last real candle to the price guide/pill so the endpoint dot
  // sits exactly where the guide line meets the Y-axis label area.
  // Only append in live mode (no user pan) so the hold doesn't distort panned views.
  //
  // Use the animation engine's interpolatedPrice when available so the endpoint
  // visually follows the smooth interpolation toward the latest real trade price,
  // rather than snapping instantly to the raw hook price.
  const guideRightX = chartWidth - PAD.right; // same x as the price guide line end
  const liveHoldX = guideRightX;
  const shouldAppendLiveHold = animEngine.state.isLiveMode &&
    baseLinePoints.length > 0 &&
    liveHoldX > lastBasePoint.x + 1;

  // When we have an interpolated price, use it for the live hold point so the
  // endpoint dot and guide line move smoothly to the new real trade price.
  const liveHoldY = interpP && interpP > 0 && minP > 0 && maxP > minP
    ? Math.max(PAD.top + 2, Math.min(PAD.top + plotH - 2, yOf(Math.max(minP, Math.min(maxP, interpP * mcapScale)))))
    : lastBasePoint.y;

  // CRITICAL: the live-hold point's ts must be set to just after the last real point
  // (not rightTime) so the gap-break check in buildGapAwareStrokePath never fires.
  // Using rightTime caused the hold segment to span multiple buckets, triggering the
  // GAP_BREAK_FACTOR=3 guard and lifting the pen — producing a detached endpoint dot.
  const liveHoldTs = lastBasePoint.ts + bucketMs * 0.4;

  const linePoints: LinePoint[] = shouldAppendLiveHold
    ? [...baseLinePoints, { x: liveHoldX, y: liveHoldY, ts: liveHoldTs, price: interpP && interpP > 0 ? interpP * mcapScale : lastBasePoint.price }]
    : baseLinePoints;

  const lastLinePoint = linePoints.length > 0
    ? linePoints[linePoints.length - 1]
    : lastBasePoint;

  // Reuse the exact same endpoint for the path, dot, and guide.
  const lastX = lastLinePoint.x;
  const lastY = lastLinePoint.y;

  const contRightX = lastX;
  const contY = lastY;
  const showContinuation = false;

  // Gap threshold: a gap larger than 3× bucketMs means two candles are not adjacent
  // in real trading time and should NOT be connected by a diagonal line.
  // The LAST segment (live-hold extension) is exempt from gap-breaking because it is
  // intentionally placed at guideRightX regardless of its timestamp.
  const GAP_BREAK_FACTOR = 3;

  function buildGapAwareStrokePath(pts: LinePoint[]): string {
    if (pts.length === 0) return '';
    const parts: string[] = [];
    let segStartIdx = 0;
    const lastIdx = pts.length - 1;
    for (let j = 0; j < pts.length; j++) {
      const x = pts[j].x.toFixed(1);
      const y = pts[j].y.toFixed(1);
      if (j === segStartIdx) {
        parts.push(`M${x},${y}`);
      } else {
        const gapMs = pts[j].ts - pts[j - 1].ts;
        // Never break before the last point — the live-hold extension must always
        // connect to the rest of the line regardless of timestamp delta.
        const isLiveHoldSegment = j === lastIdx && shouldAppendLiveHold;
        if (!isLiveHoldSegment && gapMs > bucketMs * GAP_BREAK_FACTOR) {
          // Check if the previous segment was a single isolated point — draw a stub
          if (j - 1 === segStartIdx) {
            const px = pts[j - 1].x;
            const py = pts[j - 1].y.toFixed(1);
            const stub = (slotW * 0.15).toFixed(1);
            parts.push(`M${(px - parseFloat(stub)).toFixed(1)},${py} L${(px + parseFloat(stub)).toFixed(1)},${py}`);
          }
          // Lift pen: jump to new position without drawing a line across the gap.
          parts.push(`M${x},${y}`);
          segStartIdx = j;
        } else {
          parts.push(`L${x},${y}`);
        }
      }
    }
    // Handle trailing isolated point (only when no live-hold was appended)
    if (!shouldAppendLiveHold && pts.length > 0 && pts.length - 1 === segStartIdx && pts.length > 1) {
      const px = pts[segStartIdx].x;
      const py = pts[segStartIdx].y.toFixed(1);
      const stub = (slotW * 0.15).toFixed(1);
      parts.push(`M${(px - parseFloat(stub)).toFixed(1)},${py} L${(px + parseFloat(stub)).toFixed(1)},${py}`);
    }
    return parts.join(' ');
  }

  // Gap-aware area fill: each contiguous segment is closed to the bottom individually
  // so no phantom fill spans across an empty gap.
  // The live-hold extension (last point when shouldAppendLiveHold) always connects.
  function buildGapAwareAreaPath(pts: LinePoint[]): string {
    if (pts.length === 0) return '';
    const segments: LinePoint[][] = [];
    let seg: LinePoint[] = [pts[0]];
    const lastIdx = pts.length - 1;
    for (let j = 1; j < pts.length; j++) {
      const gapMs = pts[j].ts - pts[j - 1].ts;
      const isLiveHoldSegment = j === lastIdx && shouldAppendLiveHold;
      if (!isLiveHoldSegment && gapMs > bucketMs * GAP_BREAK_FACTOR) {
        segments.push(seg);
        seg = [pts[j]];
      } else {
        seg.push(pts[j]);
      }
    }
    segments.push(seg);
    return segments.map(s => {
      if (s.length === 1) {
        // Single isolated point: render as a hairline vertical fill so area doesn't disappear
        const p = s[0];
        const px = p.x.toFixed(1);
        const py = p.y.toFixed(1);
        const hw = (slotW * 0.3).toFixed(1);
        return `M${(p.x - parseFloat(hw)).toFixed(1)},${py} L${(p.x + parseFloat(hw)).toFixed(1)},${py} L${(p.x + parseFloat(hw)).toFixed(1)},${bottomY} L${(p.x - parseFloat(hw)).toFixed(1)},${bottomY} Z`;
      }
      const first = s[0];
      const last  = s[s.length - 1];
      const line  = s.map((p, k) =>
        `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`
      ).join(' ');
      return `${line} L${last.x.toFixed(1)},${bottomY} L${first.x.toFixed(1)},${bottomY} Z`;
    }).join(' ');
  }

  const continuousLinePath = buildGapAwareStrokePath(linePoints);
  const lastPriceGuidePath = `M${PAD.left.toFixed(1)},${lastY.toFixed(1)} L${safeRightX.toFixed(1)},${lastY.toFixed(1)}`;

  const baseLinePath = linePoints.length >= 2 ? continuousLinePath : lastPriceGuidePath;
  const strokePath = baseLinePath;

  const shouldFillLineMode = n >= 2;
  const areaPath = shouldFillLineMode ? buildGapAwareAreaPath(linePoints) : '';

  // Dots are restricted to the final live/current point only.
  // No constellation of isolated dots: they made sparse charts look broken.
  const showOnlyLatestDot = !isVisualGuideOnly && (mode === 'area' || mode === 'line' || mode === 'mountain' || mode === 'bonding');
  // endpointX/Y are finalised after currentY is computed below so they share the same y-clamping.
  // Use a placeholder here; the real values are assigned after currentY is available.
  const endpointX = lastX;

  // ── Smart grid: use "nice" steps to avoid duplicate rounded labels ─────────
  // Computes up to `gridCount` evenly-spaced price levels using a "round number" step
  // (nearest 1/2/5 × 10^n), then formats with enough decimal places so no two labels
  // show the same rounded string.
  function buildGridLines(lo: number, hi: number, gridCount: number) {
    const range = hi - lo;
    if (range <= 0 || !isFinite(range)) return [];
    const rawStep = range / (gridCount - 1);
    const exp     = Math.floor(Math.log10(rawStep));
    const m       = rawStep / Math.pow(10, exp);
    const niceM   = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    const step    = niceM * Math.pow(10, exp);
    const start   = Math.ceil(lo / step) * step;
    const levels: { price: number; y: number; label: string }[] = [];
    const seen    = new Set<string>();

    const fmt = (v: number): string => {
      if (valueMode !== 'mcap') return `$${fmtPrice(v)}`;
      // Relative range: small ratio → need more decimal places to distinguish labels
      const relRange = range / Math.max(Math.abs(hi), 1);
      if (v >= 1e9) return `$${(v / 1e9).toFixed(relRange < 0.02 ? 3 : relRange < 0.06 ? 2 : 1)}B`;
      if (v >= 1e6) return `$${(v / 1e6).toFixed(relRange < 0.02 ? 3 : relRange < 0.06 ? 2 : 1)}M`;
      if (v >= 1e3) return `$${(v / 1e3).toFixed(relRange < 0.02 ? 3 : relRange < 0.08 ? 2 : 1)}K`;
      return `$${v.toFixed(relRange < 0.05 ? 4 : 2)}`;
    };

    for (let p = start; p <= hi + step * 0.01 && levels.length < gridCount + 2; p += step) {
      if (p < lo - step * 0.01) continue;
      const label = fmt(p);
      if (seen.has(label)) continue;
      seen.add(label);
      levels.push({ price: p, y: yOf(p), label });
    }
    return levels;
  }
  const priceGridLines = buildGridLines(minP, maxP, 6);

  // Time labels — always spaced by a "nice" human-readable interval derived from
  // the actual visible time window (xVisibleMs), not from bucketMs × visibleBuckets.
  // This ensures the axis looks clean even when the adaptive x-range has expanded
  // or contracted the window for sparse tokens.
  function niceTimeStepMs(targetMs: number): number {
    const steps = [
      1_000, 5_000, 10_000, 15_000, 30_000,
      60_000, 2*60_000, 5*60_000, 10*60_000, 15*60_000, 30*60_000,
      3_600_000, 2*3_600_000, 4*3_600_000, 6*3_600_000, 12*3_600_000,
      86_400_000, 2*86_400_000, 7*86_400_000, 14*86_400_000,
      30*86_400_000, 90*86_400_000,
    ];
    for (const s of steps) {
      if (s >= targetMs * 0.75) return s;
    }
    return steps[steps.length - 1];
  }
  const timeLabelStepMs = niceTimeStepMs(xVisibleMs / 5);
  const firstLabelTs    = Math.ceil(xLeft / timeLabelStepMs) * timeLabelStepMs;
  const timeLabels: { ts: number; x: number; label: string }[] = [];
  const timeLabelRight  = xLeft + xVisibleMs + timeLabelStepMs * 0.01;
  const seenTimeLabels  = new Set<string>();
  for (let ts = firstLabelTs; ts <= timeLabelRight; ts += timeLabelStepMs) {
    const x = tsToX(ts);
    if (x >= PAD.left + 10 && x <= chartWidth - PAD.right - 8) {
      const label = fmtTimeByStep(ts, timeLabelStepMs);
      if (!seenTimeLabels.has(label)) {
        seenTimeLabels.add(label);
        timeLabels.push({ ts, x, label });
      }
    }
  }

  // Guide line: anchored to the last rendered chart point/candle, not a separate quote source.
  // This keeps the price pill, dotted guide, endpoint dot, and visible path synchronized.
  // When the animation engine has an interpolated price, the guide tracks it so the
  // dashed line and price pill move together with the endpoint dot.
  const scaledGuidePrice = (() => {
    if (interpP && interpP > 0 && animEngine.state.isLiveMode) {
      return interpP * mcapScale;
    }
    if (linePoints.length > 0) return linePoints[linePoints.length - 1].price;
    if (displayCandles.length > 0) return displayCandles[displayCandles.length - 1].close;
    return fallbackGuideValue > 0 ? fallbackGuideValue : 0;
  })();
  const scaledLivePrice  = liveScaledValue; // header/display only — can include quote prices
  const clampedGuide = scaledGuidePrice > maxP ? maxP : scaledGuidePrice < minP ? minP : scaledGuidePrice;
  const currentY     = Math.max(PAD.top + 2, Math.min(PAD.top + plotH - 2, yOf(clampedGuide)));

  // Endpoint dot: shares the exact same Y as the price guide so dot and guide are always on
  // the same horizontal. When live mode extends the line to guideRightX, the dot coincides
  // with the left edge of the price pill — no visual gap between line end and pill.
  const endpointY = currentY;

  // History start indicator
  const historyOldestTs   = candles.length > 0 ? candles[0].timestamp : Date.now();
  const historyLatestTs   = candles.length > 0 ? candles[candles.length - 1].timestamp : Date.now();
  const historySpanMs     = Math.max(0, historyLatestTs - historyOldestTs);
  const historyMaxPanBack = candles.length > 0
    ? Math.max(0, Math.ceil(historySpanMs / bucketMs) - Math.floor(visibleBuckets * 0.92)) : 0;
  // Hide the start marker for now; it was visually confusing on sparse charts and is not data.
  const atHistoryStart = false;

  return (
    <View style={styles.container}>
      {header}

      {crosshair && (
        <View style={styles.crosshairBar}>
          <Text style={styles.crosshairDate}>{fmtDateTime(crosshair.ts)}</Text>
          <Text style={styles.crosshairPrice}>{fmtValue(crosshair.price, valueMode)}</Text>
          <Text style={[styles.crosshairPct, { color: (crosshair.pct ?? 0) >= 0 ? '#10B981' : '#EC4899' }]}>
            {(crosshair.pct ?? 0) >= 0 ? '+' : ''}{crosshair.pct?.toFixed(2)}%{' '}
            <Text style={styles.crosshairPctRange}>range</Text>
          </Text>
          <TouchableOpacity onPress={dismissCrosshair} style={styles.crosshairClose}>
            <Text style={styles.crosshairCloseText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {userPannedRef.current && !animEngine.state.isLiveMode && (
        <TouchableOpacity
          style={styles.returnLiveBtn}
          onPress={() => {
            animEngine.actions.returnToLive();
            setCrosshair(null);
            userPannedRef.current = false;
            priceScaleKeyRef.current = '';
          }}
          activeOpacity={0.8}>
          <Text style={styles.returnLiveText}>▶ Return to Live</Text>
        </TouchableOpacity>
      )}

      <View style={styles.chartArea}>
        {loading && candles.length > 0 && (
          <View style={[styles.loadingOverlay, { height: CHART_H }]} pointerEvents="none">
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        )}

        <View
          ref={svgContainerRef}
          style={[
            styles.svgWrap,
            Platform.OS === 'web' && ({
              userSelect: 'none',
              WebkitUserSelect: 'none',
              MozUserSelect: 'none',
              // pan-y: vertical page scroll still works; PanResponder captures horizontal
            // overscrollBehaviorX: contain keeps horizontal swipe inside the chart and
            // prevents the browser from interpreting it as a back/forward navigation gesture.
            touchAction: 'pan-y',
            overscrollBehaviorX: 'contain',
            WebkitOverflowScrolling: 'touch',
            } as any),
          ]}
          {...panResponder.panHandlers}
          {...(webMouseHandlers as any)}
          onLayout={() => {
            svgContainerRef.current?.measure((_fx, _fy, _w, _h, px, py) => {
              svgOffsetRef.current = { x: px, y: py };
            });
          }}
        >
          <Svg width={chartWidth} height={totalH}>
            <Defs>
              <SvgLinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#8B5CF6" stopOpacity="0.5" />
                <Stop offset="60%"  stopColor="#8B5CF6" stopOpacity="0.1" />
                <Stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
              </SvgLinearGradient>
              <SvgLinearGradient id="mountainGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#8B5CF6" stopOpacity="0.55" />
                <Stop offset="60%"  stopColor="#8B5CF6" stopOpacity="0.08" />
                <Stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
              </SvgLinearGradient>
              <SvgLinearGradient id="bondingGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#06B6D4" stopOpacity="0.45" />
                <Stop offset="60%"  stopColor="#06B6D4" stopOpacity="0.1" />
                <Stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
              </SvgLinearGradient>
              <SvgLinearGradient id="volGradGreen" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#8B5CF6" stopOpacity="0.8" />
                <Stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.25" />
              </SvgLinearGradient>
              <SvgLinearGradient id="volGradRed" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%"   stopColor="#EC4899" stopOpacity="0.8" />
                <Stop offset="100%" stopColor="#EC4899" stopOpacity="0.25" />
              </SvgLinearGradient>
              <ClipPath id="chartClip">
                <Rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
              </ClipPath>
              <ClipPath id="volumeClip">
                <Rect x={PAD.left} y={volumeTopY} width={plotW} height={volumeAreaH} />
              </ClipPath>
              <ClipPath id="timeAxisClip">
                <Rect x={PAD.left} y={timeAxisTopY} width={plotW} height={TIME_H} />
              </ClipPath>
            </Defs>

            <Rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="rgba(255,255,255,0.01)" />
            <Rect x={PAD.left} y={volumeTopY} width={plotW} height={volumeAreaH} fill="rgba(255,255,255,0.006)" />
            <Rect x={PAD.left} y={timeAxisTopY} width={plotW} height={TIME_H} fill="rgba(9,9,15,0.92)" />

            {/* Horizontal grid + price labels */}
            {priceGridLines.map(({ y, label }, i) => (
              <G key={`g${i}`}>
                {showGrid && (
                  <Line x1={PAD.left} y1={y} x2={chartWidth - PAD.right} y2={y}
                    stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
                )}
                <SvgText
                  x={chartWidth - PAD.right + 4} y={y + 3.5}
                  fontSize={isMobile ? 11 : 8.5}
                  fill={isMobile ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)'}
                  fontWeight={isMobile ? '600' : '400'}
                  textAnchor="start">
                  {label}
                </SvgText>
              </G>
            ))}

            <Line x1={chartWidth - PAD.right} y1={PAD.top} x2={chartWidth - PAD.right} y2={PAD.top + plotH}
              stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <Line x1={PAD.left} y1={PAD.top + plotH} x2={chartWidth - PAD.right} y2={PAD.top + plotH}
              stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

            {/* Chart data clipped to plot area */}
            <G clipPath="url(#chartClip)">

              {mode === 'area' && (
                <>
                  {areaPath ? <Path d={areaPath} fill="url(#areaGrad)" /> : null}
                  <Path d={strokePath} stroke="rgba(139,92,246,0.25)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={strokePath} stroke="#A78BFA" strokeWidth={isSparseChart ? 2.5 : 2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </>
              )}

              {mode === 'line' && (
                <>
                  <Path d={strokePath} stroke="rgba(139,92,246,0.18)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={strokePath} stroke="#A78BFA" strokeWidth={isSparseChart ? 2.5 : 2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </>
              )}

              {mode === 'mountain' && (
                <>
                  {areaPath ? <Path d={areaPath} fill="url(#mountainGrad)" /> : null}
                  <Path d={strokePath} stroke="rgba(139,92,246,0.2)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={strokePath} stroke="#8B5CF6" strokeWidth={isSparseChart ? 3 : 2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </>
              )}

              {mode === 'bonding' && (
                <>
                  {areaPath ? <Path d={areaPath} fill="url(#bondingGrad)" /> : null}
                  <Path d={strokePath} stroke="rgba(6,182,212,0.18)" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={strokePath} stroke="#06B6D4" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </>
              )}

              {/* Sparse single-point markers removed: line-style modes now show one clean path and one latest endpoint only. */}

              {mode === 'bar' && !isVisualGuideOnly && displayCandles.map((c, i) => {
                const up  = c.close >= c.open;
                const col = up ? '#10B981' : '#EC4899';
                const cx  = xOf(i);
                const yH  = yOf(c.high);
                const yL  = yOf(c.low);
                const yO  = yOf(c.open);
                const yC  = yOf(c.close);
                return (
                  <G key={`bar${c.timestamp}`}>
                    {/* Thin vertical high-low spine */}
                    <Line x1={cx} y1={yH} x2={cx} y2={yL} stroke={col} strokeWidth={1} />
                    {/* Open tick — left side, pointing left */}
                    <Line x1={cx - barW} y1={yO} x2={cx} y2={yO} stroke={col} strokeWidth={1} />
                    {/* Close tick — right side, pointing right */}
                    <Line x1={cx} y1={yC} x2={cx + barW} y2={yC} stroke={col} strokeWidth={1} />
                  </G>
                );
              })}

              {mode === 'candlestick' && !isVisualGuideOnly && displayCandles.map((c, i) => {
                const up      = c.close >= c.open;
                const col     = up ? '#10B981' : '#EC4899';
                const fillCol = up ? '#10B981' : '#EC4899';
                const wickW   = candleW <= 4 ? 1 : 1.5;
                const cx      = xOf(i);
                const yHigh   = yOf(c.high);
                const yLow    = yOf(c.low);
                const bodyTop = yOf(Math.max(c.open, c.close));
                const bodyBot = yOf(Math.min(c.open, c.close));
                const rawH    = bodyBot - bodyTop;
                // Keep 1m/flat candles readable. A 1px doji line looked like a
                // random tick/bar instead of a candle on mobile. This only changes
                // visual body height; OHLC data remains untouched.
                const minBodyH = isOneMinuteTf ? 3 : isFiveMinuteTf ? 2.5 : 2;
                const bodyH = Math.max(minBodyH, rawH);
                // Center expanded body around the actual price midpoint (between bodyTop and bodyBot).
                // Do NOT shift by minBodyH/2 from bodyTop alone — that floats the body above the wick
                // for flat doji candles where bodyTop === bodyBot.
                const bodyMidY = (bodyTop + bodyBot) / 2;
                const bodyY = bodyH > rawH ? bodyMidY - bodyH / 2 : bodyTop;
                return (
                  <G key={`cs${c.timestamp}`}>
                    {/* Thin wick — always centered on the same x as the candle body */}
                    <Line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={col} strokeWidth={wickW} />
                    {/* Normal body: up = hollow outline, down = filled (TradingView convention) */}
                    {up ? (
                      <Rect x={cx - candleW / 2} y={bodyY} width={candleW} height={bodyH}
                        fill="none" stroke={fillCol} strokeWidth={1} />
                    ) : (
                      <Rect x={cx - candleW / 2} y={bodyY} width={candleW} height={bodyH}
                        fill={fillCol} />
                    )}
                  </G>
                );
              })}

            </G>{/* end chartClip */}

            {/* No continuation line: viewport movement handles live time. */}
            {showContinuation && (mode === 'candlestick' || mode === 'bar') && (
              <Line
                x1={lastX} y1={contY}
                x2={contRightX} y2={contY}
                stroke="rgba(167,139,250,0.35)"
                strokeWidth={1}
                strokeDasharray="3,4"
              />
            )}

            {/* Price guide line + pill — anchored to last real candle close (never quote-only).
                Only rendered when we have a real chart price to anchor to. */}
            {showPriceLine && scaledGuidePrice > 0 && (
              <>
                <Line
                  x1={PAD.left} y1={currentY} x2={chartWidth - PAD.right} y2={currentY}
                  stroke="#8B5CF6" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
                <Rect
                  x={chartWidth - PAD.right + 1} y={currentY - 9}
                  width={PAD.right - 2} height={18}
                  fill="#6D28D9" rx={4} />
                <SvgText
                  x={chartWidth - PAD.right + (PAD.right - 2) / 2 + 1} y={currentY + 4.5}
                  fontSize={isMobile ? 10 : 7.5} fill="#fff" textAnchor="middle" fontWeight="700">
                  {fmtValue(scaledGuidePrice, valueMode)}
                </SvgText>
              </>
            )}

            {/* Endpoint marker — static dot is attached to the last real rendered candle.
                Pulse ring appears only for confirmed real trades.
                Pulse conditions (ALL must be true):
                  1. activeLiveCandle.sourceType === 'realTrade'  — came from is_live=true DB row
                  2. tradeTimestamp < LIVE_CANDLE_STALE_MS ago    — trade was recent
                Quote-only updates (DexScreener WS, Jupiter REST, liveTokenStore) never set
                activeLiveCandle so the ring is naturally absent for those sources. */}
            {showOnlyLatestDot && (
              <G>
                {activeLiveCandle?.sourceType === 'realTrade' &&
                 (Date.now() - activeLiveCandle.tradeTimestamp) < LIVE_CANDLE_STALE_MS && (
                  <AnimatedCircle
                    cx={endpointX}
                    cy={endpointY}
                    r={isVerySparse ? 14 : 10}
                    fill="none"
                    stroke={mode === 'bonding' ? '#06B6D4' : '#A78BFA'}
                    strokeWidth={1.5}
                    opacity={chartPulseAnim}
                  />
                )}
                <Circle
                  cx={endpointX}
                  cy={endpointY}
                  r={isVerySparse ? 5 : 3.5}
                  fill={mode === 'bonding' ? '#06B6D4' : '#A78BFA'}
                />
              </G>
            )}

            {/* Volume bars in their own clipped lane — never allowed to enter the price plot. */}
            <G clipPath="url(#volumeClip)">
              {showVolume && displayCandles.map((c, i) => {
                const h    = volBarH(c.volume);
                if (h <= 0) return null;
                const w    = Math.max(barW, 1.5);
                const vx   = xOf(i);
                const isUp = c.close >= c.open;
                return (
                  <Rect key={`v${c.timestamp}`}
                    x={vx - w / 2}
                    y={volumeTopY + (volumeAreaH - h)}
                    width={w}
                    height={h}
                    fill={isUp ? 'url(#volGradGreen)' : 'url(#volGradRed)'}
                    opacity={i === n - 1 ? 0.9 : 0.45}
                    rx={1} />
                );
              })}
            </G>

            <Line x1={PAD.left} y1={CHART_H} x2={chartWidth - PAD.right} y2={CHART_H}
              stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
            <Line x1={PAD.left} y1={timeAxisTopY} x2={chartWidth - PAD.right} y2={timeAxisTopY}
              stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

            <G clipPath="url(#timeAxisClip)">
              {timeLabels.map(({ ts, x, label }) => (
                <SvgText key={`tl${ts}`} x={x} y={timeAxisTopY + TIME_H - 4}
                  fontSize={9} fill="rgba(255,255,255,0.35)" textAnchor="middle">
                  {label}
                </SvgText>
              ))}
            </G>

            {atHistoryStart && (
              <SvgText x={PAD.left + 6} y={CHART_H - 8} fontSize={9}
                fill="rgba(255,255,255,0.25)" textAnchor="start">
                {'← Start of available history'}
              </SvgText>
            )}

            {crosshair && (
              <G>
                <Line x1={crosshair.x} y1={PAD.top} x2={crosshair.x} y2={CHART_H + VOL_H}
                  stroke="rgba(255,255,255,0.3)" strokeWidth={1} strokeDasharray="3,3" />
                <Line x1={PAD.left} y1={crosshair.y} x2={chartWidth - PAD.right} y2={crosshair.y}
                  stroke="rgba(255,255,255,0.25)" strokeWidth={1} strokeDasharray="3,3" />
                <Circle cx={crosshair.x} cy={crosshair.y} r={5}
                  fill="#8B5CF6" stroke="#fff" strokeWidth={1.5} opacity={0.95} />
                <Rect x={chartWidth - PAD.right + 1} y={crosshair.y - 9}
                  width={PAD.right - 2} height={18} fill="#8B5CF6" rx={3} />
                <SvgText
                  x={chartWidth - PAD.right + (PAD.right - 2) / 2 + 1} y={crosshair.y + 4.5}
                  fontSize={isMobile ? 10 : 7.5} fill="#fff" textAnchor="middle" fontWeight="700">
                  {fmtValue(crosshair.price, valueMode)}
                </SvgText>
              </G>
            )}
          </Svg>

        </View>
      </View>

      {showProChart && (
        <View style={styles.proChartOverlay} pointerEvents="auto">
          <DawenProChart
            tokenInfo={resolvedInfo}
            symbol={sym}
            currentPrice={displayPriceVal}
            pairAddress={resolvedPairAddr ?? pairAddress}
            tokenMint={tokenMint}
            valueMode={valueMode}
            initialTimeframe={timeframe === '1s' ? '1m' : timeframe}
            onClose={() => setShowProChart(false)}
            onTradePress={() => setShowProChart(false)}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#09090F',
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.18)',
  },
  proChartOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#06060B',
  },
  chartHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(139,92,246,0.08)',
    gap: 8,
  },
  chartHeaderSlim: { paddingTop: 8, paddingBottom: 6, gap: 0 },
  tokenInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tokenLogoLg: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#1A1A2E' },
  tokenLogoLgFallback: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: '#1A1A2E',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(139,92,246,0.25)',
  },
  tokenLogoLgText: { fontSize: 14, fontWeight: '900', color: '#A78BFA' },
  tokenInfoMid: { flex: 1, gap: 2 },
  tokenNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tokenNameText: { fontSize: 15, fontWeight: '800', color: '#fff', letterSpacing: -0.2, flexShrink: 1 },
  liveWsDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' },
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addrText: { fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: 'SpaceMono-Regular' },
  tokenPriceRight: { alignItems: 'flex-end', gap: 3 },
  tokenBigPrice: { fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: -0.5 },
  tokenChangeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tokenChangePct: { fontSize: 12, fontWeight: '700' },
  tfControlRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tfScroll: { flex: 1 },
  tfScrollContent: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 4 },
  tfPill: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.04)' },
  tfPillActive: { backgroundColor: 'rgba(139,92,246,0.25)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.5)' },
  tfPillText: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.4)' },
  tfPillTextActive: { color: '#A78BFA' },
  chartCtrlBtns: { flexDirection: 'row', gap: 4 },
  chartCtrlBtn: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  chartCtrlBtnActive: { backgroundColor: 'rgba(139,92,246,0.2)', borderColor: 'rgba(139,92,246,0.4)' },
  tradingViewBtn: {
    minWidth: 30, height: 30, borderRadius: 8,
    paddingHorizontal: 7,
    backgroundColor: 'rgba(139,92,246,0.12)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(167,139,250,0.35)',
  },
  tradingViewBtnText: { fontSize: 10, fontWeight: '900', color: '#A78BFA', letterSpacing: 0.4 },
  modePanelRow: {
    flexDirection: 'row', gap: 4, flexWrap: 'wrap',
    backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 6,
  },
  modePanelItem: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 7, flex: 1, justifyContent: 'center', minWidth: 70,
  },
  modePanelItemActive: { backgroundColor: colors.primary },
  modePanelLabel: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.4)' },
  modePanelLabelActive: { color: '#fff' },
  crosshairBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: 7,
    backgroundColor: 'rgba(139,92,246,0.1)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(139,92,246,0.12)',
    gap: spacing.md,
  },
  crosshairDate:  { fontSize: 10, color: colors.textMuted, fontWeight: '600', flex: 1 },
  crosshairPrice: { fontSize: 11, color: colors.textPrimary, fontWeight: '800' },
  crosshairPct:   { fontSize: 11, fontWeight: '700', minWidth: 52, textAlign: 'right' },
  crosshairPctRange: { fontSize: 9, fontWeight: '400', color: 'rgba(255,255,255,0.35)' },
  crosshairClose: { padding: 4 },
  crosshairCloseText: { fontSize: 11, color: colors.textMuted },
  chartArea: { position: 'relative' },
  svgWrap: { paddingTop: 4, paddingBottom: 2, position: 'relative', overflow: 'hidden' },
  loadingOverlay: { position: 'absolute', left: 0, right: 0, top: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)', zIndex: 10 },
  loadingWrap:    { height: 220, justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  loadingSubText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '500' },
  unavailableWrap: { height: 160, justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  unavailableText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '500' },
  priceFallback:   { fontSize: 24, fontWeight: '900', color: colors.primary },
  returnLiveBtn: {
    alignSelf: 'center',
    backgroundColor: 'rgba(139,92,246,0.15)',
    borderWidth: 1, borderColor: 'rgba(139,92,246,0.4)',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginVertical: 4,
  },
  returnLiveText: { fontSize: 11, fontWeight: '700', color: '#A78BFA', letterSpacing: 0.3 },
  settingsPanel: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10, padding: spacing.md,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    gap: spacing.sm,
  },
  settingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsLabel: { fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: '600' },
  settingsToggleGroup: { flexDirection: 'row', gap: 4 },
  settingsToggleBtn: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  settingsToggleBtnActive: { backgroundColor: 'rgba(139,92,246,0.3)', borderColor: 'rgba(167,139,250,0.5)' },
  settingsToggleText: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.4)' },
  settingsToggleTextActive: { color: '#A78BFA' },
  settingsSwitch: {
    width: 36, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', paddingHorizontal: 2,
  },
  settingsSwitchOn: { backgroundColor: 'rgba(139,92,246,0.6)' },
  settingsSwitchThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.5)' },
  settingsSwitchThumbOn: { backgroundColor: '#fff', transform: [{ translateX: 16 }] },
});
