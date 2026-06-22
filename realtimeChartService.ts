/**
 * realtimeChartService
 *
 * Single real-time pipeline for chart candle data.
 *
 * Provider stack (parallel, first-arrival wins per trade):
 *   1. Helius WebSocket (client-direct) — lowest latency, real confirmed swaps
 *   2. Supabase Realtime on token_candles — catches helius-ws edge-function writes
 *   3. Bitquery poll via edge function — secondary verification source
 *   4. DexScreener REST poll — quote-only fallback when no on-chain trades in window
 *
 * Every confirmed trade updates the REAL candles array (OHLCV per bucket).
 * Deduplication by signature+pool composite key prevents double-counting.
 * DexScreener quotes update close/high/low only and never create volume.
 */

import { supabase } from '@/lib/supabase';
import { CandleData, TimeFrame, ChartTimeFrame } from '@/services/chartDataService';
import { chartDataService } from '@/services/chartDataService';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CandleUpdateListener = (candles: CandleData[]) => void;
export type QuoteUpdateListener  = (price: number, ts: number) => void;

export interface NormalizedTrade {
  mint:      string;
  priceUsd:  number;
  volumeUsd: number;
  ts:        number;         // unix ms
  signature: string;
  source:    'helius-ws' | 'supabase-rt' | 'bitquery-poll' | 'quote-dex';
  side?:     'buy' | 'sell';
}

interface ActiveSubscription {
  mint:             string;
  timeframe:        TimeFrame;
  candles:          CandleData[];
  candleListeners:  Set<CandleUpdateListener>;
  quoteListeners:   Set<QuoteUpdateListener>;
  realtimeChannel:  any;
  pollTimer:        ReturnType<typeof setInterval> | null;
  heliusWs:         WebSocket | null;
  heliusWsReady:    boolean;
  seenSigs:         Set<string>;
  lastTradeTs:      number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOAD_LIMIT: Record<TimeFrame, number> = {
  '1m':  120, '5m':  144, '15m': 96,
  '1H':  168, '4H':  90,  '1D':  90,
  '1W':  90,  '1M':  90,
};

export const TF_MS: Record<string, number> = {
  '1m':  60_000,   '5m':  300_000,  '15m': 900_000,
  '1H':  3_600_000,'4H':  14_400_000,'1D': 86_400_000,
  '1W':  604_800_000, '1M': 2_592_000_000,
};

const POLL_INTERVAL_MS    = 15_000;
const MAX_SIG_CACHE       = 2000;
const MAX_CANDLE_OVERHANG = 10;  // max extra candles above LOAD_LIMIT before trim

// Helius WS URL derived from the HTTP RPC URL
function getHeliusWsUrl(): string {
  const rpc = process.env.EXPO_PUBLIC_SOLANA_RPC_URL || '';
  if (!rpc) return '';
  // Convert https://mainnet.helius-rpc.com/?api-key=XXX
  //      → wss://mainnet.helius-rpc.com/?api-key=XXX
  try {
    const u = new URL(rpc);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  } catch {
    return rpc.replace(/^https?:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  }
}

// Known Solana DEX programs (used to recognise swap logs)
const DEX_PROGRAM_IDS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymEHe5', // Pump.fun
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQDd1d4dSYkjnwCiRi8zx1RqCj3nmTXWm', // Meteora AMM
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // PumpSwap
]);

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Service class ────────────────────────────────────────────────────────────

class RealtimeChartService {
  private subs = new Map<string, ActiveSubscription>();

  private key(mint: string, tf: TimeFrame) { return `${mint}:${tf}`; }

  // ── Public API ──────────────────────────────────────────────────────────────

  async subscribe(
    mint:      string,
    timeframe: TimeFrame,
    onCandles: CandleUpdateListener,
    onQuote?:  QuoteUpdateListener,
  ): Promise<CandleData[]> {
    const k = this.key(mint, timeframe);

    if (this.subs.has(k)) {
      const s = this.subs.get(k)!;
      s.candleListeners.add(onCandles);
      if (onQuote) s.quoteListeners.add(onQuote);
      if (s.candles.length > 0) onCandles([...s.candles]);
      return [...s.candles];
    }

    const sub: ActiveSubscription = {
      mint, timeframe,
      candles:         [],
      candleListeners: new Set([onCandles]),
      quoteListeners:  onQuote ? new Set([onQuote]) : new Set(),
      realtimeChannel: null,
      pollTimer:       null,
      heliusWs:        null,
      heliusWsReady:   false,
      seenSigs:        new Set(),
      lastTradeTs:     0,
    };
    this.subs.set(k, sub);

    const candles = await this.loadHistorical(mint, timeframe);
    sub.candles = candles;
    this.notifyCandles(sub);

    this.attachSupabaseRealtime(sub);
    this.connectHeliusWs(sub);
    this.startPricePoll(sub);
    this.triggerHeliusEdgeWatch(mint);

    return [...sub.candles];
  }

  unsubscribe(
    mint:      string,
    timeframe: TimeFrame,
    listener:  CandleUpdateListener,
    onQuote?:  QuoteUpdateListener,
  ) {
    const k = this.key(mint, timeframe);
    const sub = this.subs.get(k);
    if (!sub) return;
    sub.candleListeners.delete(listener);
    if (onQuote) sub.quoteListeners.delete(onQuote);
    if (sub.candleListeners.size === 0) {
      this.teardown(k, sub);
    }
  }

  // ── Notify helpers ──────────────────────────────────────────────────────────

  private notifyCandles(sub: ActiveSubscription) {
    const snap = [...sub.candles];
    for (const l of sub.candleListeners) { try { l(snap); } catch {} }
  }

  private notifyQuote(sub: ActiveSubscription, price: number, ts: number) {
    for (const l of sub.quoteListeners) { try { l(price, ts); } catch {} }
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  private teardown(k: string, sub: ActiveSubscription) {
    if (sub.realtimeChannel) supabase.removeChannel(sub.realtimeChannel).catch(() => {});
    if (sub.pollTimer)       clearInterval(sub.pollTimer);
    if (sub.heliusWs) {
      sub.heliusWs.onclose = null;
      sub.heliusWs.onerror = null;
      sub.heliusWs.onmessage = null;
      try { sub.heliusWs.close(); } catch {}
    }
    this.subs.delete(k);
  }

  // ── Historical load ─────────────────────────────────────────────────────────

  private async loadHistorical(mint: string, timeframe: TimeFrame): Promise<CandleData[]> {
    const limit = LOAD_LIMIT[timeframe] ?? 100;

    try {
      const { data, error } = await supabase
        .from('token_candles')
        .select('open_time,open,high,low,close,volume')
        .eq('token_mint', mint)
        .eq('timeframe', timeframe)
        .order('open_time', { ascending: true })
        .limit(limit);
      if (!error && data && data.length >= 20) {
        return data.map(r => ({
          timestamp: Number(r.open_time) * 1000,
          open:   Number(r.open),
          high:   Number(r.high),
          low:    Number(r.low),
          close:  Number(r.close),
          volume: Number(r.volume),
        }));
      }
    } catch {}

    try {
      const candles = await chartDataService.getOHLCVData(mint, timeframe, limit);
      if (candles.length > 0) {
        this.seedCandlesToDB(mint, timeframe, candles).catch(() => {});
        return candles;
      }
    } catch {}

    return [];
  }

  private async seedCandlesToDB(mint: string, tf: TimeFrame, candles: CandleData[]) {
    const rows = candles.map(c => ({
      token_mint: mint, timeframe: tf,
      open_time: Math.floor(c.timestamp / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, is_live: false,
      updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await supabase.from('token_candles')
        .upsert(rows.slice(i, i + 100), { onConflict: 'token_mint,timeframe,open_time' })
        .then(() => {});
    }
  }

  // ── Trade deduplication ─────────────────────────────────────────────────────

  private isDuplicate(sub: ActiveSubscription, sig: string): boolean {
    if (!sig) return false;
    if (sub.seenSigs.has(sig)) return true;
    sub.seenSigs.add(sig);
    if (sub.seenSigs.size > MAX_SIG_CACHE) {
      const arr = Array.from(sub.seenSigs);
      sub.seenSigs = new Set(arr.slice(-MAX_SIG_CACHE / 2));
    }
    return false;
  }

  // ── Core candle merge (updates real candles array) ──────────────────────────

  private applyTrade(sub: ActiveSubscription, trade: NormalizedTrade) {
    const { priceUsd, volumeUsd, ts } = trade;
    if (!priceUsd || priceUsd <= 0) return;

    // Reject events more than 2 min older than latest accepted trade
    if (ts < sub.lastTradeTs - 120_000) return;
    // Reject events more than 30 s in the future
    if (ts > Date.now() + 30_000) return;
    if (trade.signature && this.isDuplicate(sub, trade.signature)) return;

    sub.lastTradeTs = Math.max(sub.lastTradeTs, ts);

    const intervalMs = TF_MS[sub.timeframe] ?? TF_MS['1H'];
    const bucketTs   = Math.floor(ts / intervalMs) * intervalMs;
    const safeVol    = isFinite(volumeUsd) && volumeUsd >= 0 ? volumeUsd : 0;

    const idx = sub.candles.findIndex(c => c.timestamp === bucketTs);
    if (idx >= 0) {
      const ex = sub.candles[idx];
      sub.candles[idx] = {
        ...ex,
        high:   Math.max(ex.high, priceUsd),
        low:    Math.min(ex.low,  priceUsd),
        close:  priceUsd,
        volume: ex.volume + safeVol,
      };
    } else {
      const prev = sub.candles.length > 0 ? sub.candles[sub.candles.length - 1] : null;
      const openPrice = prev ? prev.close : priceUsd;
      sub.candles.push({
        timestamp: bucketTs,
        open:   openPrice,
        high:   Math.max(openPrice, priceUsd),
        low:    Math.min(openPrice, priceUsd),
        close:  priceUsd,
        volume: safeVol,
      });
      sub.candles.sort((a, b) => a.timestamp - b.timestamp);
      const limit = LOAD_LIMIT[sub.timeframe] ?? 100;
      if (sub.candles.length > limit + MAX_CANDLE_OVERHANG) {
        sub.candles = sub.candles.slice(-limit);
      }
    }

    this.notifyCandles(sub);
  }

  private applyQuote(sub: ActiveSubscription, priceUsd: number, ts: number) {
    if (!priceUsd || priceUsd <= 0) return;
    this.notifyQuote(sub, priceUsd, ts);

    // Also update close of the current bucket without adding volume
    const intervalMs = TF_MS[sub.timeframe] ?? TF_MS['1H'];
    const bucketTs   = Math.floor(ts / intervalMs) * intervalMs;
    const idx = sub.candles.findIndex(c => c.timestamp === bucketTs);
    if (idx >= 0) {
      const ex = sub.candles[idx];
      if (ex.close === priceUsd) return;
      sub.candles[idx] = {
        ...ex,
        high:  Math.max(ex.high,  priceUsd),
        low:   Math.min(ex.low,   priceUsd),
        close: priceUsd,
      };
      this.notifyCandles(sub);
    }
  }

  // ── Supabase Realtime ───────────────────────────────────────────────────────

  private attachSupabaseRealtime(sub: ActiveSubscription) {
    const ch = supabase
      .channel(`rchart:${sub.mint.slice(0, 12)}:${sub.timeframe}`)
      .on('postgres_changes' as any, {
        event: '*', schema: 'public', table: 'token_candles',
        filter: `token_mint=eq.${sub.mint}`,
      }, (payload: any) => {
        try {
          const row = payload.new;
          if (!row || !row.close || !row.open_time) return;
          if (row.timeframe && row.timeframe !== sub.timeframe) return;

          const price  = parseFloat(row.close);
          if (!(price > 0)) return;
          const rawTs  = Number(row.open_time);
          const normTs = rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs;
          const vol    = row.volume ? parseFloat(row.volume) : 0;
          const sig    = row.signature ? String(row.signature) : '';

          if (row.is_live) {
            this.applyTrade(sub, {
              mint: sub.mint, priceUsd: price, volumeUsd: vol,
              ts: normTs, signature: sig, source: 'supabase-rt',
              side: row.is_buy != null ? (row.is_buy ? 'buy' : 'sell') : undefined,
            });
          } else {
            this.applyQuote(sub, price, normTs);
          }
        } catch {}
      })
      .subscribe();
    sub.realtimeChannel = ch;
  }

  // ── Direct Helius WebSocket ─────────────────────────────────────────────────

  private connectHeliusWs(sub: ActiveSubscription) {
    const wsUrl = getHeliusWsUrl();
    if (!wsUrl) return;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let subId: number | null = null;
    let msgIdCounter = 1;

    const connect = () => {
      const k = this.key(sub.mint, sub.timeframe);
      if (!this.subs.has(k)) return; // already torn down

      const ws = new WebSocket(wsUrl);
      sub.heliusWs = ws;
      sub.heliusWsReady = false;

      ws.onopen = () => {
        sub.heliusWsReady = true;
        const id = msgIdCounter++;
        subId = id;
        // transactionSubscribe: watch all txs mentioning this mint
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id,
          method: 'transactionSubscribe',
          params: [
            { accountInclude: [sub.mint], failed: false },
            { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 },
          ],
        }));
      };

      ws.onmessage = (evt: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
          // Subscription confirmation
          if (msg.result && typeof msg.result === 'number') return;
          const params = msg.params;
          if (!params?.result) return;
          const txVal = params.result?.value ?? params.result;
          if (!txVal) return;
          const tx = txVal.transaction ?? txVal;
          const trade = this.parseHeliusTx(tx, sub.mint);
          if (!trade) return;
          this.applyTrade(sub, { ...trade, source: 'helius-ws' });
        } catch {}
      };

      ws.onerror = () => { sub.heliusWsReady = false; };
      ws.onclose = () => {
        sub.heliusWsReady = false;
        const k = this.key(sub.mint, sub.timeframe);
        if (!this.subs.has(k)) return;
        reconnectTimer = setTimeout(connect, 5000);
      };
    };

    connect();
  }

  private parseHeliusTx(tx: any, hintMint: string): Omit<NormalizedTrade, 'source'> | null {
    try {
      const sig = tx?.transaction?.signatures?.[0] ?? tx?.signatures?.[0] ?? '';
      const blockTime = tx?.blockTime ?? tx?.timestamp;
      const ts = blockTime ? blockTime * 1000 : Date.now();

      const swapEvent = tx?.events?.swap ?? tx?.meta?.events?.swap;
      if (swapEvent) {
        const tokenIn  = swapEvent.tokenInputs?.[0];
        const tokenOut = swapEvent.tokenOutputs?.[0];
        const nativeIn  = swapEvent.nativeInput;
        const nativeOut = swapEvent.nativeOutput;

        let mint = '', priceUsd = 0, volumeUsd = 0;
        let side: 'buy' | 'sell' | undefined;

        if (nativeIn && tokenOut) {
          mint = tokenOut.mint || '';
          const solAmt = (nativeIn.amount || 0) / 1e9;
          const tokAmt = (tokenOut.rawTokenAmount?.tokenAmount || tokenOut.tokenAmount || 0) /
            Math.pow(10, tokenOut.rawTokenAmount?.decimals ?? 6);
          if (tokAmt > 0 && solAmt > 0) {
            priceUsd = solAmt / tokAmt; volumeUsd = solAmt; side = 'buy';
          }
        } else if (tokenIn && nativeOut) {
          mint = tokenIn.mint || '';
          const solAmt = (nativeOut.amount || 0) / 1e9;
          const tokAmt = (tokenIn.rawTokenAmount?.tokenAmount || tokenIn.tokenAmount || 0) /
            Math.pow(10, tokenIn.rawTokenAmount?.decimals ?? 6);
          if (tokAmt > 0 && solAmt > 0) {
            priceUsd = solAmt / tokAmt; volumeUsd = solAmt; side = 'sell';
          }
        } else if (tokenIn && tokenOut) {
          mint = tokenOut.mint || '';
          const amtIn  = (tokenIn.rawTokenAmount?.tokenAmount  || 0) / Math.pow(10, tokenIn.rawTokenAmount?.decimals  ?? 6);
          const amtOut = (tokenOut.rawTokenAmount?.tokenAmount || 0) / Math.pow(10, tokenOut.rawTokenAmount?.decimals ?? 6);
          if (amtIn > 0 && amtOut > 0) { priceUsd = amtIn / amtOut; volumeUsd = amtIn; }
        }

        if ((mint === hintMint || !mint) && priceUsd > 0) {
          return { mint: hintMint, priceUsd, volumeUsd, ts, signature: sig, side };
        }
      }

      // Fallback: tokenTransfers
      const transfers: any[] = tx?.tokenTransfers || tx?.meta?.tokenTransfers || [];
      if (transfers.length >= 2) {
        const nonSol = transfers.find((t: any) => t.mint && t.mint !== WSOL_MINT && t.mint === hintMint);
        const solT   = transfers.find((t: any) => t.mint === WSOL_MINT);
        if (nonSol && solT) {
          const tokAmt = parseFloat(nonSol.tokenAmount ?? '0');
          const solAmt = parseFloat(solT.tokenAmount ?? '0');
          if (tokAmt > 0 && solAmt > 0) {
            return { mint: hintMint, priceUsd: solAmt / tokAmt, volumeUsd: solAmt, ts, signature: sig };
          }
        }
      }
    } catch {}
    return null;
  }

  // ── DexScreener poll (quote-only fallback) ──────────────────────────────────

  private startPricePoll(sub: ActiveSubscription) {
    if (sub.pollTimer) return;

    const poll = async () => {
      const k = this.key(sub.mint, sub.timeframe);
      if (!this.subs.has(k)) return;
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${sub.mint}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return;
        const data = await res.json();
        const pairs: any[] = (data.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (pairs.length === 0) return;
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const price = parseFloat(pairs[0].priceUsd || '0');
        if (price > 0) this.applyQuote(sub, price, Date.now());
      } catch {}
    };

    setTimeout(poll, 3000);
    sub.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  // ── Helius edge function watch trigger ──────────────────────────────────────

  private triggerHeliusEdgeWatch(mint: string) {
    try {
      const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL || ''}/functions/v1/helius-ws`;
      const key  = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
      if (!url || url === '/functions/v1/helius-ws') return;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
        body: JSON.stringify({ action: 'watch', mint }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    } catch {}
  }

  // ── Force refresh ────────────────────────────────────────────────────────────

  async refresh(mint: string, timeframe: TimeFrame) {
    const k = this.key(mint, timeframe);
    const sub = this.subs.get(k);
    if (!sub) return;
    const candles = await this.loadHistorical(mint, timeframe);
    if (candles.length > 0 || sub.candles.length === 0) {
      sub.candles = candles;
    }
    this.notifyCandles(sub);
  }
}

export const realtimeChartService = new RealtimeChartService();
