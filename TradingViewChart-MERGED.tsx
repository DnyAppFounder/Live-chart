// MERGED VERSION: Will's latest (with 1s timeframe) + Peace's 6 patches
// Base: TradingViewChart (5).tsx
// Patches applied: PATCH 1-6 (continuation line, endpoint dot, price tick)

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

const LIVE_CANDLE_STALE_MS = 5 * 60_000;

export type ChartMode = 'line' | 'area' | 'candlestick' | 'bonding' | 'bar' | 'mountain';
type ValueMode = 'mcap' | 'price';

export interface TokenInfo {
  name: string;
  symbol: string;
  image?: string;
  price: number;
  priceChange24h: number;
  marketCap?: number;
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

function sanitizeRawCandles(cs: CandleData[]): CandleData[] {
  const result: CandleData[] = [];
  for (const c of cs) {
    if (!c) continue;
    const ts = c.timestamp;
    if (!isFinite(ts) || ts <= 0) continue;
    const close = isFinite(c.close) && c.close > 0 ? c.close : 0;
    if (close <= 0) continue;
    const open  = isFinite(c.open)  && c.open  > 0 ? c.open  : close;
    const high  = isFinite(c.high)  && c.high  > 0 ? c.high  : close;
    const low   = isFinite(c.low)   && c.low   > 0 ? c.low   : close;
    const safeHigh = Math.max(high, open, close);
    const safeLow  = Math.min(low,  open, close);
    if (safeHigh < safeLow) continue;
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
      buckets.set(bucket, { timestamp: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume > 0 ? c.volume : 0 });
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

function inferBucketMs(cs: CandleData[]): number {
  if (cs.length < 2) return BUCKET_MS['1D'];
  const gaps = cs.slice(1).map((c, i) => c.timestamp - cs[i].timestamp).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function msToBestTimeFrame(ms: number): TimeFrame {
  const candidates: [number, TimeFrame][] = [
    [BUCKET_MS['1m'],  '1m'], [BUCKET_MS['5m'],  '5m'], [BUCKET_MS['15m'], '15m'],
    [BUCKET_MS['1H'],  '1H'], [BUCKET_MS['4H'],  '4H'], [BUCKET_MS['1D'],  '1D'],
    [BUCKET_MS['1W'],  '1W'], [BUCKET_MS['1M'],  '1M'],
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
    if (score > bestScore) { bestScore = score; best = cleaned; }
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
  if (stepMs >= 30 * 86_400_000) return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  if (stepMs >= 7 * 86_400_000)  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (stepMs >= 86_400_000)      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (stepMs < 60_000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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

const resolvedPairCache = new Map<string, string>();

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
  const [allEffectiveTf, setAllEffectiveTf] = useState<TimeFrame>('1D');

  const allEffectiveBucketMs = timeframe === 'ALL'
    ? (BUCKET_MS[allEffectiveTf] ?? 86_400_000)
    : (BUCKET_MS[timeframe] ?? 3_600_000);

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

  useEffect(() => {
    if (timeframe !== 'ALL' || candles.length < 2) return;
    const medianGap = inferBucketMs(candles);
    setAllEffectiveTf(msToBestTimeFrame(medianGap));
  }, [timeframe, candles]);

  const [mode, setMode] = useState<ChartMode>('area');
  const [internalValueMode, setInternalValueMode] = useState<ValueMode>('mcap');
  const valueMode: ValueMode = externalValueMode ?? internalValueMode;
  const setValueMode = (v: ValueMode) => {
    if (onValueModeChange) onValueModeChange(v);
    else setInternalValueMode(v);
  };
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

  const plotWRef              = useRef(0);
  const currentPanOffsetMsRef = useRef(0);
  const panStartOffsetMsRef   = useRef(0);
  const gestureModeRef        = useRef<'idle' | 'crosshair' | 'pan'>('idle');
  const touchStartXRef        = useRef(0);
  const touchStartYRef        = useRef(0);
  const touchStartTimeRef     = useRef(0);
  const rankedPairsRef        = useRef<string[]>([]);
  const priceScaleRef         = useRef({ maxP: 0, minP: 0, priceRange: 1, maxVol: 1 });
  const priceScaleKeyRef      = useRef('');
  const pollTimerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef                 = useRef<WebSocket | null>(null);
  const livePriceRef          = useRef<number | null>(null);
  const wsDebounceRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRetryCountRef       = useRef(0);
  const svgContainerRef       = useRef<View>(null);
  const svgOffsetRef          = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const candlesRef            = useRef<CandleData[]>([]);
  const displayCandlesRef     = useRef<CandleData[]>([]);
  const pairAddrRef           = useRef<string | null>(pairAddress ?? null);
  const reqIdRef              = useRef(0);
  const prevMintRef           = useRef<string | undefined>(undefined);
  const hasAutoScrolledRef    = useRef(false);
  const timeframeRef          = useRef<ChartTimeFrame>('1H');
  const prevExternalPriceRef  = useRef<number>(0);
  const userPannedRef         = useRef(false);
  const latestPriceTsRef      = useRef<number>(0);
  const chartVisibleRef       = useRef(true);
  const fromStoreRef          = useRef(false);
  const userSelectedModeRef   = useRef(false);
  const stableSupplyRef       = useRef<number | null>(null);
  const leftTimeRef           = useRef<number>(Date.now() - 3_600_000 * 60);
  const visibleMsRef          = useRef<number>(3_600_000 * 60);
  const bucketMsRef           = useRef<number>(3_600_000);

  const panBucketMsForLimit = timeframe === 'ALL'
    ? (BUCKET_MS[allEffectiveTf] ?? 3_600_000)
    : (BUCKET_MS[timeframe] ?? 3_600_000);
  const panVisibleMsForLimit = (VISIBLE_BUCKETS[timeframe] ?? 48) * panBucketMsForLimit;
  const maxPanBackMs = candles.length > 0
    ? Math.max(0, Date.now() - candles[0].timestamp + panVisibleMsForLimit)
    : 0;
  const animEngine = useChartAnimationEngine(maxPanBackMs);
  const interpP = animEngine.state.interpolatedPrice;

  useEffect(() => { livePriceRef.current = livePrice; }, [livePrice]);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { pairAddrRef.current = resolvedPairAddr; }, [resolvedPairAddr]);
  useEffect(() => { timeframeRef.current = timeframe; }, [timeframe]);
  useEffect(() => { activeLiveCandleRef.current = activeLiveCandle; }, [activeLiveCandle]);

  useEffect(() => {
    if (rtLivePrice && rtLivePrice > 0) animEngine.actions.setTargetPrice(rtLivePrice);
  }, [rtLivePrice, rtLivePriceTs]);

  currentPanOffsetMsRef.current = animEngine.state.panOffsetMs;

  useEffect(() => {
    if (!tokenMint) return;
    if (pairAddress) { setResolvedPairAddr(pairAddress); pairAddrRef.current = pairAddress; return; }
    const cached = resolvedPairCache.get(tokenMint);
    if (cached) { setResolvedPairAddr(cached); pairAddrRef.current = cached; return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const pairs: any[] = (data.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (pairs.length === 0 || cancelled) return;
        const usable = pairs.filter((p: any) => parseFloat(p.priceUsd || '0') > 0 && ((p.liquidity?.usd || 0) > 0 || (p.volume?.h24 || 0) > 0));
        const ranked = (usable.length > 0 ? usable : pairs).sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const allAddrs = ranked.map((p: any) => p.pairAddress).filter(Boolean) as string[];
        const addr = allAddrs[0];
        if (!cancelled && addr) { rankedPairsRef.current = allAddrs; setResolvedPairAddr(addr); pairAddrRef.current = addr; }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [tokenMint, pairAddress]);

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(headerPulseAnim, { toValue: 2.2, duration: 400, useNativeDriver: true }),
      Animated.timing(headerPulseAnim, { toValue: 1,   duration: 400, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    // On 1s timeframe, always pulse when we have a live price — makes the dot feel alive
    const shouldPulse1s = timeframe === '1s' && livePrice && livePrice > 0;
    if (!shouldPulse1s) {
      if (!activeLiveCandle || activeLiveCandle.sourceType !== 'realTrade') { chartPulseAnim.setValue(0); return; }
      if (Date.now() - activeLiveCandle.tradeTimestamp > LIVE_CANDLE_STALE_MS) { chartPulseAnim.setValue(0); return; }
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(chartPulseAnim, { toValue: 0.65, duration: 250, useNativeDriver: false }),
      Animated.timing(chartPulseAnim, { toValue: 0,    duration: 650, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [activeLiveCandle, timeframe, livePrice]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof IntersectionObserver === 'undefined') return;
    if (!hasData) { chartVisibleRef.current = true; animEngine.actions.setChartVisible(true); return; }
    const el = svgContainerRef.current as unknown as Element;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      const v = entries[0]?.isIntersecting ?? true;
      chartVisibleRef.current = v;
      animEngine.actions.setChartVisible(v);
    }, { threshold: 0 });
    obs.observe(el);
    return () => { obs.disconnect(); chartVisibleRef.current = true; animEngine.actions.setChartVisible(true); };
  }, [hasData, animEngine.actions]);

  const applyLivePrice = useCallback((price: number, sourceTs?: number, _isRealTrade = false) => {
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
      const ws = new WebSocket(`wss://io.dexscreener.com/dex/screener/pair/solana/${pairAddr}`);
      wsRef.current = ws;
      ws.onopen  = () => { setWsConnected(true); };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const np = msg?.pair?.priceUsd ? parseFloat(msg.pair.priceUsd) : null;
          if (!np || isNaN(np) || np <= 0) return;
          const now = Date.now();
          if (wsDebounceRef.current) { livePriceRef.current = np; latestPriceTsRef.current = Math.max(latestPriceTsRef.current, now); return; }
          wsDebounceRef.current = setTimeout(() => {
            wsDebounceRef.current = null;
            applyLivePrice(livePriceRef.current ?? np, Date.now(), false);
          }, 400);
          livePriceRef.current = np;
        } catch {}
      };
      ws.onerror = () => { try { setWsConnected(false); } catch {} };
      ws.onclose = () => {
        try { setWsConnected(false); } catch {}
        wsRef.current = null;
        if (wsRetryCountRef.current >= 5) {
          const currentIdx = rankedPairsRef.current.findIndex(a => a === pairAddrRef.current);
          const nextAddr = currentIdx >= 0 && currentIdx < 2 ? rankedPairsRef.current[currentIdx + 1] : undefined;
          if (nextAddr) {
            pairAddrRef.current = nextAddr; setResolvedPairAddr(nextAddr); wsRetryCountRef.current = 0;
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            wsReconnectTimerRef.current = setTimeout(() => { wsReconnectTimerRef.current = null; if (wsRef.current === null) connectWebSocket(nextAddr); }, 5000);
          }
          return;
        }
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!chartVisibleRef.current) return;
        const delay = Math.min(5000 * Math.pow(2, wsRetryCountRef.current), 60_000);
        wsRetryCountRef.current++;
        if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = setTimeout(() => { wsReconnectTimerRef.current = null; if (pairAddrRef.current && wsRef.current === null) connectWebSocket(pairAddrRef.current); }, delay);
      };
    } catch { setWsConnected(false); }
  }, [applyLivePrice]);

  useEffect(() => {
    if (prevMintRef.current === tokenMint) return;
    prevMintRef.current = tokenMint;
    setLivePrice(null); setLive24hChange(null); livePriceRef.current = null;
    latestPriceTsRef.current = 0; hasAutoScrolledRef.current = false; wsRetryCountRef.current = 0;
    if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
    userSelectedModeRef.current = false; stableSupplyRef.current = null;
    setAllEffectiveTf('1D'); rankedPairsRef.current = [];
  }, [tokenMint]);

  useEffect(() => {
    if (!hasData || candles.length === 0 || userSelectedModeRef.current) return;
    const sevenDaysAgo = Date.now() - 7 * 86_400_000;
    const recent = candles.filter(c => c.timestamp >= sevenDaysAgo);
    const count = recent.length;
    if (count < 5) { setMode('candlestick'); return; }
    const volumeRatio = recent.filter(c => c.volume > 0).length / count;
    let maxGapMs = 0;
    for (let i = 1; i < recent.length; i++) { const g = recent[i].timestamp - recent[i - 1].timestamp; if (g > maxGapMs) maxGapMs = g; }
    const isSparse = count < 20 || volumeRatio < 0.3 || (count < 50 && maxGapMs > 86_400_000);
    setMode(isSparse ? 'candlestick' : 'area');
  }, [hasData, tokenMint]);

  useEffect(() => {
    setCrosshair(null); animEngine.actions.returnToLive(); priceScaleKeyRef.current = '';
    hasAutoScrolledRef.current = false; userPannedRef.current = false; latestPriceTsRef.current = 0;
  }, [tokenMint, timeframe]);

  useEffect(() => { setCrosshair(null); }, [mode]);

  useEffect(() => {
    if (!resolvedPairAddr) return;
    connectWebSocket(resolvedPairAddr);
    return () => {
      if (wsDebounceRef.current) { clearTimeout(wsDebounceRef.current); wsDebounceRef.current = null; }
      if (wsReconnectTimerRef.current) { clearTimeout(wsReconnectTimerRef.current); wsReconnectTimerRef.current = null; }
      wsRetryCountRef.current = 0;
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.onerror = null; wsRef.current.onmessage = null; try { wsRef.current.close(); } catch {} wsRef.current = null; }
      setWsConnected(false);
    };
  }, [resolvedPairAddr]);

  useEffect(() => {
    if (!tokenMint) return;
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    const fetchPrice = async () => {
      if (Date.now() - latestPriceTsRef.current < 7000) return;
      const startTs = Date.now();
      try {
        const jupRes = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`, { signal: AbortSignal.timeout(4000) });
        if (jupRes.ok) {
          const jupData = await jupRes.json();
          const jupPrice = Number(jupData?.data?.[tokenMint!]?.price ?? 0);
          if (jupPrice > 0) { applyLivePrice(jupPrice, startTs, false); return; }
        }
      } catch {}
      try {
        const pair = pairAddrRef.current;
        const url = pair ? `https://api.dexscreener.com/latest/dex/pairs/solana/${pair}` : `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const data = await res.json();
        const pairData = data.pair ?? data.pairs?.[0];
        if (!pairData) return;
        const p = parseFloat(pairData.priceUsd || '0');
        if (p > 0) applyLivePrice(p, startTs, false);
      } catch {}
    };
    const firstPoll = setTimeout(fetchPrice, 1500);
    pollTimerRef.current = setInterval(fetchPrice, 10_000);
    return () => { clearTimeout(firstPoll); if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [tokenMint, applyLivePrice]);

  useEffect(() => {
    const externalPrice = resolvedInfo?.price;
    if (!externalPrice || externalPrice <= 0 || externalPrice === prevExternalPriceRef.current) return;
    prevExternalPriceRef.current = externalPrice;
    applyLivePrice(externalPrice, Date.now() - 2000, false);
  }, [resolvedInfo?.price, applyLivePrice]);

  useEffect(() => {
    if (!tokenMint) return;
    const unsub = liveTokenStore.watch(tokenMint, (state) => {
      if (state.price > 0) { fromStoreRef.current = true; applyLivePrice(state.price, state.lastUpdatedAt, false); fromStoreRef.current = false; }
      if (state.priceChange24h !== 0) setLive24hChange(state.priceChange24h);
    });
    return unsub;
  }, [tokenMint, applyLivePrice]);

  useEffect(() => { hasAutoScrolledRef.current = true; }, [tokenMint, timeframe]);

  {
    if (stableSupplyRef.current === null) {
      const ts = resolvedInfo?.totalSupply;
      const sp = resolvedInfo?.price;
      const sm = resolvedInfo?.marketCap;
      if (sp && sp > 0 && sm && sm > 0) stableSupplyRef.current = sm / sp;
      else if (livePrice && livePrice > 0 && sm && sm > 0) stableSupplyRef.current = sm / livePrice;
      else if (ts && ts > 0) stableSupplyRef.current = ts;
    }
  }
  const mcapScale = valueMode === 'mcap' && stableSupplyRef.current != null ? stableSupplyRef.current : 1;

  const plotW = chartWidth - PAD.left - PAD.right;
  plotWRef.current = plotW;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const plotHRef = useRef(plotH);
  plotHRef.current = plotH;

  const bucketMs       = timeframe === 'ALL' ? (BUCKET_MS[allEffectiveTf] ?? 3_600_000) : (BUCKET_MS[timeframe] ?? 3_600_000);
  const visibleBuckets = VISIBLE_BUCKETS[timeframe] ?? 48;
  const panOffsetCandles = bucketMs > 0 ? animEngine.state.panOffsetMs / bucketMs : 0;
  let rightTime = animEngine.state.visualRightTime - animEngine.state.panOffsetMs;
  const visibleMs = visibleBuckets * bucketMs;
  let leftTime = rightTime - visibleMs;
  bucketMsRef.current = bucketMs;

  const mergedCandles = useMemo(() => {
    const deduped = dedupByBucket(candles, bucketMs);
    if (!activeLiveCandle) return deduped;
    const liveB = Math.floor(activeLiveCandle.timestamp / bucketMs) * bucketMs;
    const withoutSameBucket = deduped.filter(c => Math.floor(c.timestamp / bucketMs) * bucketMs !== liveB);
    return [...withoutSameBucket, activeLiveCandle].sort((a, b) => a.timestamp - b.timestamp);
  }, [candles, activeLiveCandle, bucketMs]);

  let xLeft = rightTime - visibleMs;
  let xVisibleMs = visibleMs;

  if (mergedCandles.length > 0) {
    const firstHistoryTs = mergedCandles[0].timestamp;
    const lastHistoryTs  = mergedCandles[mergedCandles.length - 1].timestamp;
    const leftPadMs  = Math.max(bucketMs * 1.5, visibleMs * 0.025);
    const rightPadMs = Math.min(Math.max(bucketMs * 2.5, visibleMs * 0.08), visibleMs * 0.16);
    const minLeft = firstHistoryTs - leftPadMs;

    // Will's sparse token fix — keep this
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
      xLeft = Math.max(minLeft, rightTime - visibleMs);
      xVisibleMs = visibleMs;
    }
  }

  leftTime  = xLeft;
  rightTime = xLeft + xVisibleMs;
  leftTimeRef.current  = xLeft;
  visibleMsRef.current = xVisibleMs;

  const visibleWindowStart = xLeft - bucketMs;
  const visibleWindowEnd   = xLeft + xVisibleMs + bucketMs;
  let filledRaw = mergedCandles.filter(c => c.timestamp >= visibleWindowStart && c.timestamp <= visibleWindowEnd);

  const renderGuidePrice = activeLiveCandle ? activeLiveCandle.close
    : mergedCandles.length > 0 ? mergedCandles[mergedCandles.length - 1].close
    : livePrice && livePrice > 0 ? livePrice
    : currentPrice && currentPrice > 0 ? currentPrice
    : resolvedInfo?.price && resolvedInfo.price > 0 ? resolvedInfo.price : 0;

  const hasRealRenderCandles = filledRaw.length > 0;
  const renderRaw = hasRealRenderCandles ? filledRaw : [];
  const isVisualGuideOnly = false;

  const quoteAnchorPrice = livePrice && livePrice > 0 ? livePrice
    : currentPrice && currentPrice > 0 ? currentPrice
    : resolvedInfo?.price && resolvedInfo.price > 0 ? resolvedInfo.price : 0;
  const rawLastCloseForUnit = renderRaw.length > 0 ? renderRaw[renderRaw.length - 1].close : renderGuidePrice;
  const rawToPriceRatio = quoteAnchorPrice > 0 && rawLastCloseForUnit > 0 ? rawLastCloseForUnit / quoteAnchorPrice : 1;
  const candleToPriceScale = rawToPriceRatio > 1000 || rawToPriceRatio < 0.001 ? quoteAnchorPrice / rawLastCloseForUnit : 1;
  const normalizedPriceRaw = candleToPriceScale !== 1
    ? renderRaw.map(c => ({ ...c, open: c.open * candleToPriceScale, high: c.high * candleToPriceScale, low: c.low * candleToPriceScale, close: c.close * candleToPriceScale }))
    : renderRaw;

  const displayScale = valueMode === 'mcap' ? mcapScale : 1;
  const displayCandles = displayScale !== 1
    ? normalizedPriceRaw.map(c => ({ ...c, open: c.open * displayScale, high: c.high * displayScale, low: c.low * displayScale, close: c.close * displayScale }))
    : normalizedPriceRaw;

  displayCandlesRef.current = displayCandles;
  const n = displayCandles.length;

  {
    const dcLen   = displayCandles.length;
    const dcFirst = displayCandles[0];
    const dcLast  = displayCandles[dcLen - 1];
    const visibleOnly = displayCandles.filter(c => c.timestamp >= xLeft && c.timestamp <= xLeft + xVisibleMs);
    const scaleBase   = visibleOnly.length > 0 ? visibleOnly : displayCandles;
    const realVisible = scaleBase.filter(c => c.volume > 0);
    const scaleSource = realVisible.length > 0 ? realVisible : scaleBase;
    const visMinLow  = scaleSource.length > 0 ? Math.min(...scaleSource.map(c => c.low))  : 0;
    const visMaxHigh = scaleSource.length > 0 ? Math.max(...scaleSource.map(c => c.high)) : 1;

    const key = [timeframe, valueMode, panOffsetCandles, dcLen, dcFirst?.timestamp ?? 0, dcLast?.timestamp ?? 0, Math.round(xLeft / bucketMs), Math.round(rightTime / bucketMs), visMinLow.toPrecision(4), visMaxHigh.toPrecision(4)].join('|');

    if (key !== priceScaleKeyRef.current && displayCandles.length > 0) {
      priceScaleKeyRef.current = key;
      const safeMax = isFinite(visMaxHigh) && visMaxHigh > 0 ? visMaxHigh : 1;
      const safeMin = isFinite(visMinLow)  && visMinLow  >= 0 ? visMinLow : 0;
      const range   = (safeMax - safeMin) || safeMax * 0.02 || 0.001;
      // 1s timeframe needs very tight padding so micro-movements are visible (like Pump.fun)
      const padFraction = timeframe === '1s' ? 0.03 : 0.15;
      const pad = Math.max(range * padFraction, safeMax * (scaleSource.length < 5 ? 0.04 : 0));
      const realVols = scaleBase.filter(c => c.volume > 0).map(c => c.volume);
      const sortedVols = [...realVols].sort((a, b) => a - b);
      const p90idx = Math.min(Math.floor(sortedVols.length * 0.9), sortedVols.length - 1);
      const cappedVol = sortedVols.length > 0 ? Math.max(sortedVols[p90idx] * 1.5, 1) : 1;
      const tightMin = safeMin - pad;
      // Never include zero on 1s — it would make the scale absurdly wide
      const safeMinP = (timeframe !== '1s' && (tightMin < 0 || safeMin < safeMax * 0.08)) ? Math.max(0, tightMin) : tightMin;
      priceScaleRef.current = { maxP: safeMax + pad, minP: safeMinP, priceRange: (safeMax + pad) - safeMinP || 1, maxVol: cappedVol };
    }

    const liveC = n > 0 ? displayCandles[n - 1] : null;
    if (liveC) {
      const { maxP: cMax, minP: cMin, maxVol } = priceScaleRef.current;
      const liveHigh = isFinite(liveC.high) && liveC.high > 0 ? liveC.high : 0;
      const liveLow  = isFinite(liveC.low)  && liveC.low  > 0 ? liveC.low  : cMin;
      if (liveHigh > cMax || liveLow < cMin) {
        priceScaleRef.current = { maxP: Math.max(cMax, liveHigh * 1.05), minP: Math.max(0, Math.min(cMin, liveLow * 0.95)), priceRange: (Math.max(cMax, liveHigh * 1.05)) - Math.max(0, Math.min(cMin, liveLow * 0.95)) || 1, maxVol };
      }
    }
  }
  const { maxP, minP, priceRange, maxVol } = priceScaleRef.current;
  const effectiveBuckets = visibleBuckets;
  const slotW = plotW / effectiveBuckets;
  const MAX_CANDLE_W = isMobile ? 16 : 12;
  const MAX_BAR_W    = isMobile ?  7 :  6;
  const _vSparse = n > 0 && n < 5;
  // Will's fix: 1s treated same as 1m for candle sizing
  const isOneMinuteTf  = timeframe === '1m' || timeframe === '1s';
  const isFiveMinuteTf = timeframe === '5m';
  const barW    = Math.min(MAX_BAR_W,    Math.max(isMobile ? 2.5 : 2, slotW * (_vSparse ? 0.60 : 0.42)));
  const minCandleW = isMobile ? (isOneMinuteTf ? 6 : isFiveMinuteTf ? 5 : (_vSparse ? 7 : 4)) : (isOneMinuteTf ? 5 : isFiveMinuteTf ? 4 : (_vSparse ? 6 : 3));
  const candleW = Math.min(MAX_CANDLE_W, Math.max(minCandleW, slotW * (isMobile ? (_vSparse ? 0.82 : 0.68) : (_vSparse ? 0.72 : 0.62))));

  function tsToX(ts: number): number { return PAD.left + ((ts - xLeft) / xVisibleMs) * plotW; }
  function xOf(i: number): number {
    const c = displayCandles[i];
    if (!c) return PAD.left + (i + 0.5) * (plotW / Math.max(n, 1));
    return tsToX(c.timestamp + bucketMs / 2);
  }
  function yOf(price: number) {
    const raw = PAD.top + plotH - ((price - minP) / priceRange) * plotH;
    return Math.max(PAD.top, Math.min(PAD.top + plotH, raw));
  }
  const volumeTopY  = CHART_H + 6;
  const volumeAreaH = Math.max(10, VOL_H - 12);
  const timeAxisTopY = CHART_H + VOL_H;
  function volBarH(vol: number): number {
    if (vol <= 0 || !isFinite(vol) || maxVol <= 0) return 0;
    const h = (vol / maxVol) * volumeAreaH;
    return h < 0.3 ? 0 : Math.max(1, h);
  }
  const totalH = CHART_H + VOL_H + TIME_H;

  const updateCrosshairAt = (localX: number, _localY: number) => {
    const cands = displayCandlesRef.current;
    if (!cands.length) return;
    const pw = plotWRef.current; const lt = leftTimeRef.current; const vm = visibleMsRef.current; const bm = bucketMsRef.current;
    const rawTs = lt + ((localX - PAD.left) / pw) * vm;
    let closestIdx = 0; let closestDist = Infinity;
    for (let i = 0; i < cands.length; i++) { const d = Math.abs(cands[i].timestamp + bm / 2 - rawTs); if (d < closestDist) { closestDist = d; closestIdx = i; } }
    const c  = cands[closestIdx];
    const cx = PAD.left + ((c.timestamp + bm / 2 - lt) / vm) * pw;
    const { minP: scaleMin, priceRange: scaleRange } = priceScaleRef.current;
    const ph = plotHRef.current;
    const cy = Math.max(PAD.top, Math.min(PAD.top + ph, PAD.top + ph - ((c.close - scaleMin) / scaleRange) * ph));
    const firstClose = cands[0].close;
    setCrosshair({ x: cx, y: cy, idx: closestIdx, price: c.close, ts: c.timestamp, pct: firstClose > 0 ? ((c.close - firstClose) / firstClose) * 100 : 0 });
  };

  const applyTouchToCrosshair = (pageX: number, pageY: number) => {
    if (Platform.OS === 'web') {
      const webEl = svgContainerRef.current as any;
      if (webEl?.getBoundingClientRect) { const rect = webEl.getBoundingClientRect(); svgOffsetRef.current = { x: rect.left, y: rect.top }; }
      updateCrosshairAt(pageX - svgOffsetRef.current.x, pageY - svgOffsetRef.current.y);
    } else {
      svgContainerRef.current?.measure((_fx, _fy, _w, _h, px, py) => { svgOffsetRef.current = { x: px, y: py }; updateCrosshairAt(pageX - px, pageY - py); });
    }
  };

  const mouseDragRef       = useRef(false);
  const mouseDragStartXRef = useRef(0);
  const mousePanStartRef   = useRef(0);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, gs) => { const adx = Math.abs(gs.dx); const ady = Math.abs(gs.dy); return adx > 8 && adx > ady * 1.8; },
    onPanResponderGrant: (e) => {
      panStartOffsetMsRef.current = currentPanOffsetMsRef.current; gestureModeRef.current = 'pan';
      animEngine.actions.onPanStart(); touchStartXRef.current = e.nativeEvent.pageX; touchStartYRef.current = e.nativeEvent.pageY; touchStartTimeRef.current = Date.now(); setCrosshair(null);
    },
    onPanResponderMove: (_e, gs) => {
      if (gestureModeRef.current !== 'pan') return;
      userPannedRef.current = true;
      const newOffsetMs = Math.max(0, panStartOffsetMsRef.current + (gs.dx / (plotWRef.current || 1)) * visibleMsRef.current);
      animEngine.actions.setPanOffsetMs(newOffsetMs);
    },
    onPanResponderRelease: (e) => {
      animEngine.actions.onPanEnd();
      const totalMovement = Math.hypot(e.nativeEvent.pageX - touchStartXRef.current, e.nativeEvent.pageY - touchStartYRef.current);
      const elapsed = Date.now() - touchStartTimeRef.current;
      if (gestureModeRef.current !== 'pan' || (totalMovement < 10 && elapsed < 300)) applyTouchToCrosshair(e.nativeEvent.pageX, e.nativeEvent.pageY);
      gestureModeRef.current = 'idle';
    },
    onPanResponderTerminate: () => { animEngine.actions.onPanEnd(); gestureModeRef.current = 'idle'; },
  })).current;

  const webTouchStartXRef = useRef(0);
  const webTouchStartYRef = useRef(0);

  const webMouseHandlers = Platform.OS === 'web' ? {
    onTouchStart: (e: any) => { const t = e.touches?.[0]; if (t) { webTouchStartXRef.current = t.clientX; webTouchStartYRef.current = t.clientY; } },
    onTouchMove: (e: any) => { const t = e.touches?.[0]; if (!t) return; if (Math.abs(t.clientX - webTouchStartXRef.current) > 8 && Math.abs(t.clientX - webTouchStartXRef.current) > Math.abs(t.clientY - webTouchStartYRef.current) * 2) e.preventDefault?.(); },
    onMouseMove: (e: any) => {
      if (mouseDragRef.current) {
        userPannedRef.current = true;
        animEngine.actions.setPanOffsetMs(Math.max(0, mousePanStartRef.current + ((e.clientX - mouseDragStartXRef.current) / (plotWRef.current || 1)) * visibleMsRef.current));
        setCrosshair(null);
      } else { const rect = e.currentTarget?.getBoundingClientRect?.(); if (!rect) return; updateCrosshairAt(e.clientX - rect.left, e.clientY - rect.top); }
    },
    onMouseDown: (e: any) => { mouseDragRef.current = true; mouseDragStartXRef.current = e.clientX; mousePanStartRef.current = currentPanOffsetMsRef.current; animEngine.actions.onPanStart(); e.preventDefault(); },
    onMouseUp: () => { mouseDragRef.current = false; animEngine.actions.onPanEnd(); },
    onMouseLeave: () => { mouseDragRef.current = false; animEngine.actions.onPanEnd(); },
    onWheel: (e: any) => { e.preventDefault(); const deltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; const newOffset = Math.max(0, currentPanOffsetMsRef.current + (deltaX / (plotWRef.current || 1)) * visibleMsRef.current); userPannedRef.current = newOffset > 0; animEngine.actions.setPanOffsetMs(newOffset); },
    onContextMenu: (e: any) => e.preventDefault(),
  } : {};

  const dismissCrosshair = () => setCrosshair(null);

  const sym               = resolvedInfo?.symbol ?? 'TOKEN';
  const contractAddr      = resolvedInfo?.address ?? tokenMint ?? '';
  const shortContractAddr = contractAddr ? `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}` : '';

  const latestClose     = normalizedPriceRaw.length > 0 ? normalizedPriceRaw[normalizedPriceRaw.length - 1].close : (quoteAnchorPrice > 0 ? quoteAnchorPrice : 0);
  const displayPriceVal = (interpP != null && interpP > 0 && animEngine.state.isLiveMode) ? interpP
    : (livePrice != null && livePrice > 0) ? livePrice
    : latestClose > 0 ? latestClose
    : (currentPrice != null && currentPrice > 0 ? currentPrice : 0);

  const mcapVal = resolvedInfo?.marketCap ?? null;
  const raw24h  = resolvedInfo?.priceChange24h;
  const is24hValid = (v: number | null | undefined): v is number => v !== null && v !== undefined && isFinite(v) && Math.abs(v) <= 999;
  const change24h = is24hValid(live24hChange) ? live24hChange : is24hValid(raw24h) ? raw24h : 0;
  const has24h = is24hValid(live24hChange) || (is24hValid(raw24h) && raw24h !== 0);
  const isUp = change24h >= 0;
  const changeColor = isUp ? '#10B981' : '#EC4899';
  const realAnchoredPrice = latestClose > 0 ? latestClose : displayPriceVal;
  const liveScaledValue = valueMode === 'mcap' ? realAnchoredPrice * mcapScale : displayPriceVal;
  const headerValue = valueMode === 'mcap' ? fmtMcap(mcapVal && mcapVal > 0 ? mcapVal : liveScaledValue) : `$${fmtPrice(displayPriceVal)}`;
  const currentModeConfig = CHART_MODES.find(m => m.key === mode) ?? CHART_MODES[0];
  const ModeIcon = currentModeConfig.icon;

  const handleCopyAddr = async () => { if (!contractAddr) return; await Clipboard.setStringAsync(contractAddr); setCopiedAddr(true); setTimeout(() => setCopiedAddr(false), 2000); };
  const handleOpenTradingView = () => { setShowProChart(true); };

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
            {wsConnected && <Animated.View style={[styles.liveWsDot, { transform: [{ scale: headerPulseAnim }] }]} />}
          </View>
          {shortContractAddr ? (
            <TouchableOpacity style={styles.addrRow} onPress={handleCopyAddr} activeOpacity={0.7}>
              <Text style={styles.addrText}>{shortContractAddr}</Text>
              {copiedAddr ? <CheckCircle2 size={10} color={colors.success} strokeWidth={2} /> : <Copy size={10} color="rgba(255,255,255,0.35)" strokeWidth={2} />}
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.tokenPriceRight}>
          <TouchableOpacity onPress={() => setValueMode(valueMode === 'mcap' ? 'price' : 'mcap')} activeOpacity={0.8}>
            <Text style={styles.tokenBigPrice}>{headerValue}</Text>
          </TouchableOpacity>
          <View style={styles.tokenChangeRow}>
            {has24h ? (
              <>{isUp ? <TrendingUp size={11} color={changeColor} strokeWidth={2.5} /> : <TrendingDown size={11} color={changeColor} strokeWidth={2.5} />}
              <Text style={[styles.tokenChangePct, { color: changeColor }]}>{isUp ? '+' : ''}{change24h.toFixed(2)}%</Text></>
            ) : <Text style={[styles.tokenChangePct, { color: 'rgba(255,255,255,0.3)' }]}>—</Text>}
          </View>
        </View>
      </View>}

      <View style={styles.tfControlRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tfScroll} contentContainerStyle={styles.tfScrollContent}>
          {ALL_TIMEFRAMES.map(tf => (
            <TouchableOpacity key={tf.key} style={[styles.tfPill, timeframe === tf.key && styles.tfPillActive]} onPress={() => setTimeframe(tf.key)} activeOpacity={0.7}>
              <Text style={[styles.tfPillText, timeframe === tf.key && styles.tfPillTextActive]}>{tf.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={styles.chartCtrlBtns}>
          <TouchableOpacity style={styles.tradingViewBtn} onPress={handleOpenTradingView} activeOpacity={0.8}><Text style={styles.tradingViewBtnText}>TV</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.chartCtrlBtn, showModePanel && styles.chartCtrlBtnActive]} onPress={() => { setShowModePanel(p => !p); setShowSettingsPanel(false); }} activeOpacity={0.8}>
            <ModeIcon size={15} color={showModePanel ? '#A78BFA' : 'rgba(255,255,255,0.6)'} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chartCtrlBtn, showSettingsPanel && styles.chartCtrlBtnActive]} onPress={() => { setShowSettingsPanel(p => !p); setShowModePanel(false); }} activeOpacity={0.8}>
            <SlidersHorizontal size={15} color={showSettingsPanel ? '#A78BFA' : 'rgba(255,255,255,0.6)'} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {showModePanel && (
        <View style={styles.modePanelRow}>
          {CHART_MODES.map(m => { const IconComp = m.icon; const active = mode === m.key; return (
            <TouchableOpacity key={m.key} style={[styles.modePanelItem, active && styles.modePanelItemActive]} onPress={() => { userSelectedModeRef.current = true; setMode(m.key); setShowModePanel(false); }} activeOpacity={0.75}>
              <IconComp size={14} color={active ? '#fff' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2.5 : 2} />
              <Text style={[styles.modePanelLabel, active && styles.modePanelLabelActive]}>{m.label}</Text>
            </TouchableOpacity>
          ); })}
        </View>
      )}

      {showSettingsPanel && (
        <View style={styles.settingsPanel}>
          <View style={styles.settingsRow}>
            <Text style={styles.settingsLabel}>Display</Text>
            <View style={styles.settingsToggleGroup}>
              <TouchableOpacity style={[styles.settingsToggleBtn, valueMode === 'mcap' && styles.settingsToggleBtnActive]} onPress={() => setValueMode('mcap')} activeOpacity={0.75}><Text style={[styles.settingsToggleText, valueMode === 'mcap' && styles.settingsToggleTextActive]}>MCAP</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.settingsToggleBtn, valueMode === 'price' && styles.settingsToggleBtnActive]} onPress={() => setValueMode('price')} activeOpacity={0.75}><Text style={[styles.settingsToggleText, valueMode === 'price' && styles.settingsToggleTextActive]}>PRICE</Text></TouchableOpacity>
            </View>
          </View>
          {[['Volume bars', showVolume, setShowVolume], ['Price guide', showPriceLine, setShowPriceLine], ['Grid lines', showGrid, setShowGrid]].map(([label, val, setter]: any) => (
            <View key={label as string} style={styles.settingsRow}>
              <Text style={styles.settingsLabel}>{label}</Text>
              <TouchableOpacity style={[styles.settingsSwitch, val && styles.settingsSwitchOn]} onPress={() => setter((v: boolean) => !v)} activeOpacity={0.75}>
                <View style={[styles.settingsSwitchThumb, val && styles.settingsSwitchThumbOn]} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
  );

  const autoScrollPending = !hasAutoScrolledRef.current && candles.length > 0 && displayCandles.length === 0;
  const isFirstLoad = ((loading && candles.length === 0 && displayPriceVal <= 0) || autoScrollPending);

  if (isFirstLoad) return (
    <View style={styles.container}>{header}
      <View style={[styles.loadingWrap, { height: CHART_H }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.loadingSubText}>Loading chart…</Text></View>
    </View>
  );

  if (!hasData && candles.length === 0 && displayPriceVal <= 0) return (
    <View style={styles.container}>{header}
      <View style={[styles.unavailableWrap, { height: CHART_H }]}>
        {displayPriceVal > 0 ? (<><Text style={styles.priceFallback}>{fmtValue(valueMode === 'mcap' ? (mcapVal ?? displayPriceVal * mcapScale) : displayPriceVal, valueMode)}</Text><Text style={styles.unavailableText}>Price unavailable</Text></>) : <Text style={styles.unavailableText}>Chart temporarily unavailable</Text>}
      </View>
    </View>
  );

  if (n === 0 && displayPriceVal <= 0) return (
    <View style={styles.container}>{header}
      <View style={[styles.unavailableWrap, { height: CHART_H }]}>
        {displayPriceVal > 0 ? (<><Text style={styles.priceFallback}>{fmtValue(valueMode === 'mcap' ? (mcapVal ?? displayPriceVal * mcapScale) : displayPriceVal, valueMode)}</Text><Text style={styles.unavailableText}>Loading price…</Text></>) : <ActivityIndicator size="small" color={colors.primary} />}
      </View>
    </View>
  );

  // ── Sparse detection ──────────────────────────────────────────────────────
  const _renderSortedGaps = displayCandles.slice(1).map((c, i) => c.timestamp - displayCandles[i].timestamp).sort((a, b) => a - b);
  const renderMedianGapMs = _renderSortedGaps.length > 0 ? _renderSortedGaps[Math.floor(_renderSortedGaps.length / 2)] : bucketMs;
  const _flatCount = displayCandles.filter(c => Math.abs(c.high - c.low) < Math.max(c.close, 1e-12) * 1e-6).length;
  const _flatRatio = displayCandles.length > 0 ? _flatCount / displayCandles.length : 0;
  const isSparseChart = displayCandles.length < 30 || renderMedianGapMs > bucketMs * 2 || _flatRatio > 0.5;
  const isVerySparse = n < 5;

  // ── Build paths ───────────────────────────────────────────────────────────
  const bottomY    = (PAD.top + plotH).toFixed(1);
  const plotRightX = PAD.left + plotW;
  const safeRightX = plotRightX - (isMobile ? 34 : 28);
  const isLineVisualMode = mode === 'area' || mode === 'line' || mode === 'mountain' || mode === 'bonding';

  type LinePoint = { x: number; y: number; ts: number; price: number };
  const rawLinePoints: LinePoint[] = displayCandles.map((c, i) => ({ x: xOf(i), y: yOf(c.close), ts: c.timestamp + bucketMs / 2, price: c.close }));

  const baseLinePoints: LinePoint[] = (() => {
    if (!isLineVisualMode || rawLinePoints.length < 2) return rawLinePoints;
    if (bucketMs > 5 * 60_000) return rawLinePoints;
    const filled: LinePoint[] = [];
    for (let i = 0; i < rawLinePoints.length; i++) {
      filled.push(rawLinePoints[i]);
      if (i < rawLinePoints.length - 1) {
        const curr = rawLinePoints[i]; const next = rawLinePoints[i + 1];
        const gapMs = next.ts - curr.ts;
        if (gapMs > bucketMs * 1.5) {
          const steps = Math.min(Math.floor(gapMs / bucketMs) - 1, 120);
          for (let k = 1; k <= steps; k++) {
            const fillTs = curr.ts + k * bucketMs;
            if (fillTs >= next.ts) break;
            filled.push({ x: curr.x + (next.x - curr.x) * (k * bucketMs / gapMs), y: curr.y, ts: fillTs, price: curr.price });
          }
        }
      }
    }
    return filled;
  })();

  const fallbackGuideValue = valueMode === 'mcap' ? (quoteAnchorPrice > 0 ? quoteAnchorPrice * mcapScale : minP) : (quoteAnchorPrice > 0 ? quoteAnchorPrice : minP);
  const lastBasePoint = baseLinePoints.length > 0 ? baseLinePoints[baseLinePoints.length - 1] : { x: PAD.left, y: yOf(fallbackGuideValue), ts: xLeft, price: fallbackGuideValue };

  const guideRightX = chartWidth - PAD.right;
  const liveHoldX = guideRightX;
  const shouldAppendLiveHold = animEngine.state.isLiveMode && baseLinePoints.length > 0 && liveHoldX > lastBasePoint.x + 1;

  const liveHoldY = interpP && interpP > 0 && minP > 0 && maxP > minP
    ? Math.max(PAD.top + 2, Math.min(PAD.top + plotH - 2, yOf(Math.max(minP, Math.min(maxP, interpP * mcapScale)))))
    : lastBasePoint.y;

  // Will's fix: use lastBasePoint.ts + bucketMs * 0.4 so gap-break never fires on live hold
  const liveHoldTs = lastBasePoint.ts + bucketMs * 0.4;

  const linePoints: LinePoint[] = shouldAppendLiveHold
    ? [...baseLinePoints, { x: liveHoldX, y: liveHoldY, ts: liveHoldTs, price: interpP && interpP > 0 ? interpP * mcapScale : lastBasePoint.price }]
    : baseLinePoints;

  const lastLinePoint = linePoints.length > 0 ? linePoints[linePoints.length - 1] : lastBasePoint;
  const lastX = lastLinePoint.x;
  const lastY = lastLinePoint.y;

  // *** PATCH 1: Enable live continuation for candle/bar modes ***
  const showContinuation = animEngine.state.isLiveMode && !isLineVisualMode && displayCandles.length > 0;

  const GAP_BREAK_FACTOR = 3;

  function buildGapAwareStrokePath(pts: LinePoint[]): string {
    if (pts.length === 0) return '';
    const parts: string[] = [];
    let segStartIdx = 0;
    const lastIdx = pts.length - 1;
    for (let j = 0; j < pts.length; j++) {
      const x = pts[j].x.toFixed(1); const y = pts[j].y.toFixed(1);
      if (j === segStartIdx) {
        parts.push(`M${x},${y}`);
      } else {
        const gapMs = pts[j].ts - pts[j - 1].ts;
        const isLiveHoldSegment = j === lastIdx && shouldAppendLiveHold;
        if (!isLiveHoldSegment && gapMs > bucketMs * GAP_BREAK_FACTOR) {
          if (j - 1 === segStartIdx) { const px = pts[j - 1].x; const py = pts[j - 1].y.toFixed(1); const stub = (slotW * 0.15).toFixed(1); parts.push(`M${(px - parseFloat(stub)).toFixed(1)},${py} L${(px + parseFloat(stub)).toFixed(1)},${py}`); }
          parts.push(`M${x},${y}`); segStartIdx = j;
        } else { parts.push(`L${x},${y}`); }
      }
    }
    if (!shouldAppendLiveHold && pts.length > 0 && pts.length - 1 === segStartIdx && pts.length > 1) {
      const px = pts[segStartIdx].x; const py = pts[segStartIdx].y.toFixed(1); const stub = (slotW * 0.15).toFixed(1);
      parts.push(`M${(px - parseFloat(stub)).toFixed(1)},${py} L${(px + parseFloat(stub)).toFixed(1)},${py}`);
    }
    return parts.join(' ');
  }

  function buildGapAwareAreaPath(pts: LinePoint[]): string {
    if (pts.length === 0) return '';
    const segments: LinePoint[][] = [];
    let seg: LinePoint[] = [pts[0]];
    const lastIdx = pts.length - 1;
    for (let j = 1; j < pts.length; j++) {
      const isLiveHoldSegment = j === lastIdx && shouldAppendLiveHold;
      if (!isLiveHoldSegment && pts[j].ts - pts[j - 1].ts > bucketMs * GAP_BREAK_FACTOR) { segments.push(seg); seg = [pts[j]]; }
      else seg.push(pts[j]);
    }
    segments.push(seg);
    return segments.map(s => {
      if (s.length === 1) { const p = s[0]; const hw = (slotW * 0.3).toFixed(1); return `M${(p.x - parseFloat(hw)).toFixed(1)},${p.y.toFixed(1)} L${(p.x + parseFloat(hw)).toFixed(1)},${p.y.toFixed(1)} L${(p.x + parseFloat(hw)).toFixed(1)},${bottomY} L${(p.x - parseFloat(hw)).toFixed(1)},${bottomY} Z`; }
      const first = s[0]; const last = s[s.length - 1];
      return s.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ` L${last.x.toFixed(1)},${bottomY} L${first.x.toFixed(1)},${bottomY} Z`;
    }).join(' ');
  }

  const continuousLinePath = buildGapAwareStrokePath(linePoints);
  const lastPriceGuidePath = `M${PAD.left.toFixed(1)},${lastY.toFixed(1)} L${safeRightX.toFixed(1)},${lastY.toFixed(1)}`;
  const strokePath = linePoints.length >= 2 ? continuousLinePath : lastPriceGuidePath;
  const areaPath = n >= 2 ? buildGapAwareAreaPath(linePoints) : '';

  // *** PATCH 3: Show endpoint dot in ALL chart modes ***
  const showOnlyLatestDot = !isVisualGuideOnly && displayCandles.length > 0;

  // *** PATCH 4: Position endpoint dot at live edge in live mode ***
  const endpointX = animEngine.state.isLiveMode ? guideRightX : lastX;

  function buildGridLines(lo: number, hi: number, gridCount: number) {
    const range = hi - lo;
    if (range <= 0 || !isFinite(range)) return [];
    const rawStep = range / (gridCount - 1);
    const exp = Math.floor(Math.log10(rawStep));
    const m = rawStep / Math.pow(10, exp);
    const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    const step = niceM * Math.pow(10, exp);
    const start = Math.ceil(lo / step) * step;
    const levels: { price: number; y: number; label: string }[] = [];
    const seen = new Set<string>();
    const fmt = (v: number): string => {
      if (valueMode !== 'mcap') return `$${fmtPrice(v)}`;
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

  function niceTimeStepMs(targetMs: number): number {
    // Will's addition: includes 1s steps for 1s timeframe
    const steps = [1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 2*60_000, 5*60_000, 10*60_000, 15*60_000, 30*60_000, 3_600_000, 2*3_600_000, 4*3_600_000, 6*3_600_000, 12*3_600_000, 86_400_000, 2*86_400_000, 7*86_400_000, 14*86_400_000, 30*86_400_000, 90*86_400_000];
    for (const s of steps) { if (s >= targetMs * 0.75) return s; }
    return steps[steps.length - 1];
  }
  const timeLabelStepMs = niceTimeStepMs(xVisibleMs / 5);
  const firstLabelTs = Math.ceil(xLeft / timeLabelStepMs) * timeLabelStepMs;
  const timeLabels: { ts: number; x: number; label: string }[] = [];
  const seenTimeLabels = new Set<string>();
  for (let ts = firstLabelTs; ts <= xLeft + xVisibleMs + timeLabelStepMs * 0.01; ts += timeLabelStepMs) {
    const x = tsToX(ts);
    if (x >= PAD.left + 10 && x <= chartWidth - PAD.right - 8) {
      const label = fmtTimeByStep(ts, timeLabelStepMs);
      if (!seenTimeLabels.has(label)) { seenTimeLabels.add(label); timeLabels.push({ ts, x, label }); }
    }
  }

  const scaledGuidePrice = (() => {
    if (interpP && interpP > 0 && animEngine.state.isLiveMode) return interpP * mcapScale;
    if (linePoints.length > 0) return linePoints[linePoints.length - 1].price;
    if (displayCandles.length > 0) return displayCandles[displayCandles.length - 1].close;
    return fallbackGuideValue > 0 ? fallbackGuideValue : 0;
  })();
  const clampedGuide = scaledGuidePrice > maxP ? maxP : scaledGuidePrice < minP ? minP : scaledGuidePrice;
  const currentY = Math.max(PAD.top + 2, Math.min(PAD.top + plotH - 2, yOf(clampedGuide)));

  // *** PATCH 2: contRightX and contY — placed AFTER currentY so contY uses live price Y ***
  const contRightX = guideRightX;
  const contY = currentY;

  const endpointY = currentY;
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
          <TouchableOpacity onPress={dismissCrosshair} style={styles.crosshairClose}><Text style={styles.crosshairCloseText}>✕</Text></TouchableOpacity>
        </View>
      )}

      {userPannedRef.current && !animEngine.state.isLiveMode && (
        <TouchableOpacity style={styles.returnLiveBtn} onPress={() => { animEngine.actions.returnToLive(); setCrosshair(null); userPannedRef.current = false; priceScaleKeyRef.current = ''; }} activeOpacity={0.8}>
          <Text style={styles.returnLiveText}>▶ Return to Live</Text>
        </TouchableOpacity>
      )}

      <View style={styles.chartArea}>
        {loading && candles.length > 0 && <View style={[styles.loadingOverlay, { height: CHART_H }]} pointerEvents="none"><ActivityIndicator size="small" color={colors.primary} /></View>}

        <View
          ref={svgContainerRef}
          style={[styles.svgWrap, Platform.OS === 'web' && ({ userSelect: 'none', WebkitUserSelect: 'none', MozUserSelect: 'none', touchAction: 'pan-y', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch' } as any)]}
          {...panResponder.panHandlers}
          {...(webMouseHandlers as any)}
          onLayout={() => { svgContainerRef.current?.measure((_fx, _fy, _w, _h, px, py) => { svgOffsetRef.current = { x: px, y: py }; }); }}
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
              <ClipPath id="chartClip"><Rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} /></ClipPath>
              <ClipPath id="volumeClip"><Rect x={PAD.left} y={volumeTopY} width={plotW} height={volumeAreaH} /></ClipPath>
              <ClipPath id="timeAxisClip"><Rect x={PAD.left} y={timeAxisTopY} width={plotW} height={TIME_H} /></ClipPath>
            </Defs>

            <Rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="rgba(255,255,255,0.01)" />
            <Rect x={PAD.left} y={volumeTopY} width={plotW} height={volumeAreaH} fill="rgba(255,255,255,0.006)" />
            <Rect x={PAD.left} y={timeAxisTopY} width={plotW} height={TIME_H} fill="rgba(9,9,15,0.92)" />

            {priceGridLines.map(({ y, label }, i) => (
              <G key={`g${i}`}>
                {showGrid && <Line x1={PAD.left} y1={y} x2={chartWidth - PAD.right} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />}
                <SvgText x={chartWidth - PAD.right + 4} y={y + 3.5} fontSize={isMobile ? 11 : 8.5} fill={isMobile ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)'} fontWeight={isMobile ? '600' : '400'} textAnchor="start">{label}</SvgText>
              </G>
            ))}

            <Line x1={chartWidth - PAD.right} y1={PAD.top} x2={chartWidth - PAD.right} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <Line x1={PAD.left} y1={PAD.top + plotH} x2={chartWidth - PAD.right} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

            <G clipPath="url(#chartClip)">
              {mode === 'area' && (<>
                {areaPath ? <Path d={areaPath} fill="url(#areaGrad)" /> : null}
                <Path d={strokePath} stroke="rgba(139,92,246,0.25)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <Path d={strokePath} stroke="#A78BFA" strokeWidth={isSparseChart ? 2.5 : 2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </>)}
              {mode === 'line' && (<>
                <Path d={strokePath} stroke="rgba(139,92,246,0.18)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <Path d={strokePath} stroke="#A78BFA" strokeWidth={isSparseChart ? 2.5 : 2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </>)}
              {mode === 'mountain' && (<>
                {areaPath ? <Path d={areaPath} fill="url(#mountainGrad)" /> : null}
                <Path d={strokePath} stroke="rgba(139,92,246,0.2)" strokeWidth={isSparseChart ? 7 : 5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <Path d={strokePath} stroke="#8B5CF6" strokeWidth={isSparseChart ? 3 : 2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </>)}
              {mode === 'bonding' && (<>
                {areaPath ? <Path d={areaPath} fill="url(#bondingGrad)" /> : null}
                <Path d={strokePath} stroke="rgba(6,182,212,0.18)" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <Path d={strokePath} stroke="#06B6D4" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </>)}

              {mode === 'bar' && !isVisualGuideOnly && displayCandles.map((c, i) => {
                const up = c.close >= c.open; const col = up ? '#10B981' : '#EC4899'; const cx = xOf(i);
                return (<G key={`bar${c.timestamp}`}>
                  <Line x1={cx} y1={yOf(c.high)} x2={cx} y2={yOf(c.low)} stroke={col} strokeWidth={1} />
                  <Line x1={cx - barW} y1={yOf(c.open)} x2={cx} y2={yOf(c.open)} stroke={col} strokeWidth={1} />
                  <Line x1={cx} y1={yOf(c.close)} x2={cx + barW} y2={yOf(c.close)} stroke={col} strokeWidth={1} />
                </G>);
              })}

              {mode === 'candlestick' && !isVisualGuideOnly && displayCandles.map((c, i) => {
                const up = c.close >= c.open; const col = up ? '#10B981' : '#EC4899';
                const cx = xOf(i); const wickW = candleW <= 4 ? 1 : 1.5;
                const bodyTop = yOf(Math.max(c.open, c.close)); const bodyBot = yOf(Math.min(c.open, c.close));
                const rawH = bodyBot - bodyTop;
                const minBodyH = isOneMinuteTf ? 3 : isFiveMinuteTf ? 2.5 : 2;
                const bodyH = Math.max(minBodyH, rawH);
                const bodyY = bodyH > rawH ? (bodyTop + bodyBot) / 2 - bodyH / 2 : bodyTop;
                return (<G key={`cs${c.timestamp}`}>
                  <Line x1={cx} y1={yOf(c.high)} x2={cx} y2={yOf(c.low)} stroke={col} strokeWidth={wickW} />
                  {up ? <Rect x={cx - candleW / 2} y={bodyY} width={candleW} height={bodyH} fill="none" stroke={col} strokeWidth={1} /> : <Rect x={cx - candleW / 2} y={bodyY} width={candleW} height={bodyH} fill={col} />}
                </G>);
              })}
            </G>

            {/* *** PATCH 5: Live continuation line — enabled for candle/bar modes *** */}
            {showContinuation && (
              <Line x1={lastX} y1={contY} x2={contRightX} y2={contY} stroke="rgba(167,139,250,0.5)" strokeWidth={1.5} strokeDasharray="4,3" />
            )}

            {/* Price guide line + pill */}
            {showPriceLine && scaledGuidePrice > 0 && (<>
              <Line x1={PAD.left} y1={currentY} x2={chartWidth - PAD.right} y2={currentY} stroke="#8B5CF6" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
              <Rect x={chartWidth - PAD.right + 1} y={currentY - 9} width={PAD.right - 2} height={18} fill="#6D28D9" rx={4} />
              <SvgText x={chartWidth - PAD.right + (PAD.right - 2) / 2 + 1} y={currentY + 4.5} fontSize={isMobile ? 10 : 7.5} fill="#fff" textAnchor="middle" fontWeight="700">{fmtValue(scaledGuidePrice, valueMode)}</SvgText>
            </>)}

            {/* *** PATCH 3+4: Endpoint dot now shows in ALL modes, positioned at live edge *** */}
            {showOnlyLatestDot && (
              <G>
                {/* Pulse ring: always active on 1s for pump.fun feel, otherwise only on fresh real trades */}
                {((timeframe === '1s' && livePrice && livePrice > 0) ||
                  (activeLiveCandle?.sourceType === 'realTrade' && (Date.now() - activeLiveCandle.tradeTimestamp) < LIVE_CANDLE_STALE_MS)) && (
                  <AnimatedCircle cx={endpointX} cy={endpointY} r={isVerySparse ? 14 : 10} fill="none" stroke={mode === 'bonding' ? '#06B6D4' : '#A78BFA'} strokeWidth={1.5} opacity={chartPulseAnim} />
                )}
                <Circle cx={endpointX} cy={endpointY} r={isVerySparse ? 5 : 3.5} fill={mode === 'bonding' ? '#06B6D4' : '#A78BFA'} />
              </G>
            )}

            {/* *** PATCH 6: Live price tick on right axis for candle/bar modes *** */}
            {!isLineVisualMode && animEngine.state.isLiveMode && displayCandles.length > 0 && (
              <G>
                <Line x1={chartWidth - PAD.right - 8} y1={currentY} x2={chartWidth - PAD.right} y2={currentY} stroke="#A78BFA" strokeWidth={2.5} strokeLinecap="round" />
              </G>
            )}

            <G clipPath="url(#volumeClip)">
              {showVolume && displayCandles.map((c, i) => {
                const h = volBarH(c.volume);
                if (h <= 0) return null;
                const w = Math.max(barW, 1.5);
                return (<Rect key={`v${c.timestamp}`} x={xOf(i) - w / 2} y={volumeTopY + (volumeAreaH - h)} width={w} height={h} fill={c.close >= c.open ? 'url(#volGradGreen)' : 'url(#volGradRed)'} opacity={i === n - 1 ? 0.9 : 0.45} rx={1} />);
              })}
            </G>

            <Line x1={PAD.left} y1={CHART_H} x2={chartWidth - PAD.right} y2={CHART_H} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
            <Line x1={PAD.left} y1={timeAxisTopY} x2={chartWidth - PAD.right} y2={timeAxisTopY} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

            <G clipPath="url(#timeAxisClip)">
              {timeLabels.map(({ ts, x, label }) => (
                <SvgText key={`tl${ts}`} x={x} y={timeAxisTopY + TIME_H - 4} fontSize={9} fill="rgba(255,255,255,0.35)" textAnchor="middle">{label}</SvgText>
              ))}
            </G>

            {crosshair && (
              <G>
                <Line x1={crosshair.x} y1={PAD.top} x2={crosshair.x} y2={CHART_H + VOL_H} stroke="rgba(255,255,255,0.3)" strokeWidth={1} strokeDasharray="3,3" />
                <Line x1={PAD.left} y1={crosshair.y} x2={chartWidth - PAD.right} y2={crosshair.y} stroke="rgba(255,255,255,0.25)" strokeWidth={1} strokeDasharray="3,3" />
                <Circle cx={crosshair.x} cy={crosshair.y} r={5} fill="#8B5CF6" stroke="#fff" strokeWidth={1.5} opacity={0.95} />
                <Rect x={chartWidth - PAD.right + 1} y={crosshair.y - 9} width={PAD.right - 2} height={18} fill="#8B5CF6" rx={3} />
                <SvgText x={chartWidth - PAD.right + (PAD.right - 2) / 2 + 1} y={crosshair.y + 4.5} fontSize={isMobile ? 10 : 7.5} fill="#fff" textAnchor="middle" fontWeight="700">{fmtValue(crosshair.price, valueMode)}</SvgText>
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
  container: { backgroundColor: '#09090F', borderRadius: borderRadius.lg, overflow: 'hidden', marginBottom: 6, borderWidth: 1, borderColor: 'rgba(139,92,246,0.18)' },
  proChartOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 9999, elevation: 9999, backgroundColor: '#06060B' },
  chartHeader: { paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(139,92,246,0.08)', gap: 8 },
  chartHeaderSlim: { paddingTop: 8, paddingBottom: 6, gap: 0 },
  tokenInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tokenLogoLg: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#1A1A2E' },
  tokenLogoLgFallback: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#1A1A2E', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(139,92,246,0.25)' },
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
  chartCtrlBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  chartCtrlBtnActive: { backgroundColor: 'rgba(139,92,246,0.2)', borderColor: 'rgba(139,92,246,0.4)' },
  tradingViewBtn: { minWidth: 30, height: 30, borderRadius: 8, paddingHorizontal: 7, backgroundColor: 'rgba(139,92,246,0.12)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(167,139,250,0.35)' },
  tradingViewBtnText: { fontSize: 10, fontWeight: '900', color: '#A78BFA', letterSpacing: 0.4 },
  modePanelRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 6 },
  modePanelItem: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 7, flex: 1, justifyContent: 'center', minWidth: 70 },
  modePanelItemActive: { backgroundColor: colors.primary },
  modePanelLabel: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.4)' },
  modePanelLabelActive: { color: '#fff' },
  crosshairBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 7, backgroundColor: 'rgba(139,92,246,0.1)', borderBottomWidth: 1, borderBottomColor: 'rgba(139,92,246,0.12)', gap: spacing.md },
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
  returnLiveBtn: { alignSelf: 'center', backgroundColor: 'rgba(139,92,246,0.15)', borderWidth: 1, borderColor: 'rgba(139,92,246,0.4)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginVertical: 4 },
  returnLiveText: { fontSize: 11, fontWeight: '700', color: '#A78BFA', letterSpacing: 0.3 },
  settingsPanel: { backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: spacing.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', gap: spacing.sm },
  settingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsLabel: { fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: '600' },
  settingsToggleGroup: { flexDirection: 'row', gap: 4 },
  settingsToggleBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  settingsToggleBtnActive: { backgroundColor: 'rgba(139,92,246,0.3)', borderColor: 'rgba(167,139,250,0.5)' },
  settingsToggleText: { fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.4)' },
  settingsToggleTextActive: { color: '#A78BFA' },
  settingsSwitch: { width: 36, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', paddingHorizontal: 2 },
  settingsSwitchOn: { backgroundColor: 'rgba(139,92,246,0.6)' },
  settingsSwitchThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.5)' },
  settingsSwitchThumbOn: { backgroundColor: '#fff', transform: [{ translateX: 16 }] },
});
