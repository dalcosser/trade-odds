/**
 * bookRules.mjs — Codified trading book rules applied to ClickHouse technicals.
 *
 * Pure functions, zero LLM. Takes a ClickHouse daily_ohlcv row and returns
 * which book setups are firing. Based on 8 books extracted in trading_book_rules.md.
 *
 * Usage:
 *   import { applyBookRules, classifyRegime } from './lib/bookRules.mjs';
 *   const rules = applyBookRules(chRow);
 *   // Returns: [{ rule, source, signal, detail, priority }]
 */

// ── Weinstein Stage Classification ────────────────────────
// Uses 200-day SMA as proxy for 30-week WMA (close enough for daily data)
function weinsteinStage(r) {
  const ma = r.SMA_200;
  const slope = r.SMA_200_Slope1;
  const close = r.Close;
  if (!ma || !slope) return null;

  let stage, detail;

  if (slope < -0.01 && close < ma) {
    stage = 4; detail = 'Below declining 200d — Stage 4 (declining)';
  } else if (Math.abs(slope) <= 0.01 && close < ma * 1.03) {
    // Flat MA, check if we came from decline or advance
    if (r.Ret_60d < 0) {
      stage = 1; detail = `200d flattening after decline — Stage 1 (basing)`;
    } else {
      stage = 3; detail = `200d flattening after advance — Stage 3 (topping)`;
    }
  } else if (slope > 0.01 && close > ma) {
    stage = 2; detail = 'Above rising 200d — Stage 2 (advancing)';
  } else if (slope > 0 && close < ma) {
    stage = 3; detail = 'Dropped below rising 200d — Stage 3 risk';
  } else {
    stage = 1; detail = 'Transitional — near 200d';
  }

  const signal = stage === 2 ? 'bullish' : stage === 4 ? 'bearish' : 'neutral';
  return { rule: `Weinstein Stage ${stage}`, source: 'Weinstein', signal, detail, priority: stage === 2 ? 6 : stage === 4 ? 6 : 3 };
}

// ── Weinstein Breakout Detection ──────────────────────────
function weinsteinBreakout(r) {
  if (!r.Is_20d_High || !r.SMA_200 || !r.SMA_200_Slope1) return null;

  // Price at 20-day high + above rising 200d + volume confirmation
  if (r.Is_20d_High && r.Close > r.SMA_200 && r.SMA_200_Slope1 > 0) {
    const volRatio = r.AvgVol_20 > 0 ? r.Volume / r.AvgVol_20 : 0;
    if (volRatio >= 1.5) {
      const quality = volRatio >= 3 ? 'A+' : volRatio >= 2 ? 'A' : 'B';
      return {
        rule: 'Weinstein Breakout',
        source: 'Weinstein',
        signal: 'bullish',
        detail: `20d high + rising 200d + vol ${volRatio.toFixed(1)}x (${quality} grade)`,
        priority: 9,
      };
    }
  }
  return null;
}

// ── Bollinger Squeeze ─────────────────────────────────────
function bollingerSqueeze(r) {
  if (!r.BB_Upper_20 || !r.BB_Lower_20 || !r.BB_Middle_20) return null;

  const bandwidth = (r.BB_Upper_20 - r.BB_Lower_20) / r.BB_Middle_20;
  // Squeeze: bandwidth < 8% (tight bands) — proxy for 6-month low without lookback
  if (bandwidth < 0.08) {
    return {
      rule: 'Bollinger Squeeze',
      source: 'Bollinger',
      signal: 'neutral',
      detail: `BW ${(bandwidth * 100).toFixed(1)}% — breakout imminent, direction TBD`,
      priority: 7,
    };
  }
  return null;
}

// ── Bollinger Band Walk (Trend Continuation) ──────────────
function bollingerWalk(r) {
  if (!r.BB_Upper_20 || !r.BB_Lower_20) return null;

  if (r.Close > r.BB_Upper_20) {
    return {
      rule: 'BB Walk (Upper)',
      source: 'Bollinger',
      signal: 'bullish',
      detail: `Close above upper BB — trend continuation, NOT reversal`,
      priority: 5,
    };
  }
  if (r.Close < r.BB_Lower_20) {
    return {
      rule: 'BB Walk (Lower)',
      source: 'Bollinger',
      signal: 'bearish',
      detail: `Close below lower BB — downtrend continuation`,
      priority: 5,
    };
  }
  return null;
}

// ── Bollinger %b Extreme ──────────────────────────────────
function bollingerPctB(r) {
  if (!r.BB_Upper_20 || !r.BB_Lower_20) return null;

  const bw = r.BB_Upper_20 - r.BB_Lower_20;
  if (bw <= 0) return null;
  const pctB = (r.Close - r.BB_Lower_20) / bw;

  if (pctB > 0.95) {
    return {
      rule: 'BB %b Extreme High',
      source: 'Bollinger',
      signal: 'bullish',
      detail: `%b=${pctB.toFixed(2)} — extended but trending (sell only if RSI diverges)`,
      priority: 4,
    };
  }
  if (pctB < 0.05) {
    return {
      rule: 'BB %b Extreme Low',
      source: 'Bollinger',
      signal: 'bearish',
      detail: `%b=${pctB.toFixed(2)} — oversold territory (watch for W-bottom)`,
      priority: 5,
    };
  }
  return null;
}

// ── MACD Divergence (best oscillator signal per Encyclopedia) ──
function macdDivergence(r) {
  if (r.MACD == null || r.MACD_Hist == null) return null;

  // Bullish: price at/near 20d low but MACD_Hist rising
  if (r.Close <= r.Low_20d * 1.02 && r.MACD_Hist > 0) {
    return {
      rule: 'MACD Bullish Divergence',
      source: 'Encyclopedia',
      signal: 'bullish',
      detail: `Price near 20d low but MACD histogram positive — best oscillator signal`,
      priority: 8,
    };
  }

  // Bearish: price at/near 20d high but MACD_Hist falling
  if (r.Close >= r.High_20d * 0.98 && r.MACD_Hist < 0) {
    return {
      rule: 'MACD Bearish Divergence',
      source: 'Encyclopedia',
      signal: 'bearish',
      detail: `Price near 20d high but MACD histogram negative — momentum fading`,
      priority: 8,
    };
  }
  return null;
}

// ── MACD Zero Cross ───────────────────────────────────────
function macdZeroCross(r) {
  if (r.MACD == null || r.MACD_Signal == null) return null;

  // MACD crossing above signal from below zero = strongest buy
  if (r.MACD > r.MACD_Signal && r.MACD < 0 && r.MACD_Hist > 0) {
    return {
      rule: 'MACD Buy Cross',
      source: 'Murphy/Elder',
      signal: 'bullish',
      detail: `MACD crossing signal below zero — best buy zone`,
      priority: 6,
    };
  }

  // MACD crossing below signal from above zero = strongest sell
  if (r.MACD < r.MACD_Signal && r.MACD > 0 && r.MACD_Hist < 0) {
    return {
      rule: 'MACD Sell Cross',
      source: 'Murphy/Elder',
      signal: 'bearish',
      detail: `MACD crossing signal above zero — distribution zone`,
      priority: 6,
    };
  }
  return null;
}

// ── RSI Regime Classification (Cardwell/Hayden) ───────────
function rsiRegime(r) {
  const rsi = r.RSI_14;
  if (rsi == null) return null;

  // Bull regime: RSI supports at 40, resists at 80
  if (rsi >= 40 && rsi <= 80) {
    if (rsi >= 65) {
      return {
        rule: 'RSI Bull Regime (Strong)',
        source: 'Hayden/Cardwell',
        signal: 'bullish',
        detail: `RSI ${rsi.toFixed(0)} in bull zone (40-80), approaching resistance`,
        priority: 4,
      };
    }
    if (rsi <= 45) {
      return {
        rule: 'RSI Bull Support Test',
        source: 'Hayden/Cardwell',
        signal: 'bullish',
        detail: `RSI ${rsi.toFixed(0)} testing bull support at 40 — bounce expected`,
        priority: 6,
      };
    }
  }

  // Bear regime: RSI supports at 20, resists at 60
  if (rsi < 40) {
    return {
      rule: 'RSI Bear Regime',
      source: 'Hayden/Cardwell',
      signal: 'bearish',
      detail: `RSI ${rsi.toFixed(0)} < 40 — bear regime (resistance at 60, support at 20)`,
      priority: 5,
    };
  }

  // Overbought extreme
  if (rsi > 80) {
    return {
      rule: 'RSI Overbought',
      source: 'Hayden/Cardwell',
      signal: 'neutral',
      detail: `RSI ${rsi.toFixed(0)} > 80 — take partial profits, do NOT short (Cardwell rule)`,
      priority: 5,
    };
  }

  return null;
}

// ── Elder Triple Screen ───────────────────────────────────
// Simplified: weekly MACD direction (via MACD slope) + daily RSI
function elderTripleScreen(r) {
  if (r.MACD_Hist == null || r.RSI_14 == null) return null;

  // Weekly tide approximation: MACD histogram direction over recent bars
  // Positive and rising = bullish tide; negative and falling = bearish tide
  const weeklyBullish = r.MACD_Hist > 0;
  const weeklyBearish = r.MACD_Hist < 0;

  // Screen 2: daily oscillator opposite to weekly = entry
  if (weeklyBullish && r.RSI_14 < 40) {
    return {
      rule: 'Elder Triple Screen Buy',
      source: 'Elder',
      signal: 'bullish',
      detail: `Weekly tide bullish (MACD_Hist +${r.MACD_Hist.toFixed(2)}) + daily RSI oversold (${r.RSI_14.toFixed(0)}) — buy signal`,
      priority: 8,
    };
  }

  if (weeklyBearish && r.RSI_14 > 60) {
    return {
      rule: 'Elder Triple Screen Sell',
      source: 'Elder',
      signal: 'bearish',
      detail: `Weekly tide bearish (MACD_Hist ${r.MACD_Hist.toFixed(2)}) + daily RSI elevated (${r.RSI_14.toFixed(0)}) — short signal`,
      priority: 7,
    };
  }
  return null;
}

// ── Holy Grail (Connors/Raschke) ──────────────────────────
// ADX > 30 rising + pullback to 20 EMA
function holyGrail(r) {
  // We don't have ADX directly, but can approximate trending:
  // Strong trend = SMA_10_Slope > 0 + tight to EMA_21 + RSI 40-65
  if (!r.EMA_21 || !r.SMA_10_Slope1) return null;

  const nearEMA = Math.abs(r.Close - r.EMA_21) / r.EMA_21 < 0.015; // within 1.5%
  const trending = r.SMA_10_Slope1 > 0.1 && r.SMA_50_Slope1 > 0;
  const pullback = r.RSI_14 >= 35 && r.RSI_14 <= 55; // pulled back but not broken

  if (nearEMA && trending && pullback) {
    return {
      rule: 'Holy Grail Pullback',
      source: 'Connors/Raschke',
      signal: 'bullish',
      detail: `Trend intact (10d slope +${r.SMA_10_Slope1.toFixed(2)}) + pullback to 21 EMA ($${r.EMA_21.toFixed(2)}) + RSI ${r.RSI_14.toFixed(0)}`,
      priority: 8,
    };
  }
  return null;
}

// ── ID/NR4 (Connors/Raschke) ─────────────────────────────
// Inside day + narrowest 4-day range = volatility explosion
function idNR4(r) {
  // Approximate: small range relative to ATR = compressed
  if (!r.ATR_14 || !r.RangePct) return null;

  const dailyRange = r.High - r.Low;
  const isNarrow = dailyRange < r.ATR_14 * 0.5; // range < half ATR = very narrow
  const isInside = r.High < r.High_20d && r.Low > r.Low_20d; // within recent range

  if (isNarrow) {
    return {
      rule: 'Narrow Range (ID/NR4 variant)',
      source: 'Connors/Raschke',
      signal: 'neutral',
      detail: `Range ${(dailyRange).toFixed(2)} < 0.5x ATR (${r.ATR_14.toFixed(2)}) — volatility explosion coming`,
      priority: 6,
    };
  }
  return null;
}

// ── MA Alignment Score ────────────────────────────────────
function maAlignment(r) {
  if (!r.SMA_10 || !r.SMA_50 || !r.SMA_200) return null;

  const above10 = r.Close > r.SMA_10;
  const above50 = r.Close > r.SMA_50;
  const above200 = r.Close > r.SMA_200;
  const slopeUp10 = r.SMA_10_Slope1 > 0;
  const slopeUp50 = r.SMA_50_Slope1 > 0;
  const slopeUp200 = r.SMA_200_Slope1 > 0;

  const bullScore = [above10, above50, above200, slopeUp10, slopeUp50, slopeUp200].filter(Boolean).length;
  const bearScore = [!above10, !above50, !above200, !slopeUp10, !slopeUp50, !slopeUp200].filter(Boolean).length;

  if (bullScore >= 5) {
    return {
      rule: 'Full Bull Alignment',
      source: 'Murphy/Weinstein',
      signal: 'bullish',
      detail: `${bullScore}/6 MA alignment — above all MAs, all slopes rising`,
      priority: 5,
    };
  }
  if (bearScore >= 5) {
    return {
      rule: 'Full Bear Alignment',
      source: 'Murphy/Weinstein',
      signal: 'bearish',
      detail: `${bearScore}/6 MA alignment — below all MAs, all slopes declining`,
      priority: 5,
    };
  }
  return null;
}

// ── Volume Confirmation (Murphy) ──────────────────────────
function volumeConfirmation(r) {
  if (!r.Volume || !r.AvgVol_20) return null;

  const volRatio = r.Volume / r.AvgVol_20;

  // Price up on heavy volume = strong
  if (r.DayPct > 0.02 && volRatio > 2) {
    return {
      rule: 'Volume Confirmation',
      source: 'Murphy',
      signal: 'bullish',
      detail: `+${(r.DayPct * 100).toFixed(1)}% on ${volRatio.toFixed(1)}x avg volume — institutional accumulation`,
      priority: 6,
    };
  }

  // Price down on heavy volume = bearish
  if (r.DayPct < -0.02 && volRatio > 2) {
    return {
      rule: 'Volume Distribution',
      source: 'Murphy',
      signal: 'bearish',
      detail: `${(r.DayPct * 100).toFixed(1)}% on ${volRatio.toFixed(1)}x avg volume — institutional distribution`,
      priority: 6,
    };
  }

  // New high on declining volume = warning
  if (r.Is_20d_High && volRatio < 0.7) {
    return {
      rule: 'Low-Volume New High',
      source: 'Murphy',
      signal: 'neutral',
      detail: `New 20d high on only ${volRatio.toFixed(1)}x avg volume — suspect`,
      priority: 4,
    };
  }
  return null;
}

// ── Money Management (Elder) ──────────────────────────────
function riskCheck(r) {
  if (r.Drawdown == null || r.ATR_14 == null) return null;

  // Drawdown > 15% = danger zone (Elder 6% rule extrapolated)
  if (r.Drawdown < -0.15) {
    return {
      rule: 'Deep Drawdown',
      source: 'Elder',
      signal: 'bearish',
      detail: `DD ${(r.Drawdown * 100).toFixed(1)}% — Elder: reduce position size, tighten stops`,
      priority: 7,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// DeMark — The New Science of Technical Analysis (Wiley 1994)
//
// All DeMark rules below operate on a SERIES of bars (most recent LAST).
// Bar shape: { Close, High, Low, Open, Timestamp } — matches getDailyBars().
// They are skipped silently when bars are not provided to applyBookRules.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TD Price Flip — the prerequisite for any TD Setup.
 *   Bullish flip: today close > close 4 days ago, after at least one prior
 *                 day where close < close 4 days ago.
 *   Bearish flip: inverse.
 * Source: DeMark Ch 7, "Setup" section.
 */
function tdPriceFlip(bars) {
  if (!bars || bars.length < 6) return null;
  const n = bars.length;
  const c = (i) => bars[i].Close;
  const today = c(n - 1), yest = c(n - 2);
  const today4 = c(n - 5), yest4 = c(n - 6);
  if (today > today4 && yest <= yest4) {
    return { rule: 'TD Price Flip (Bullish)', source: 'DeMark', signal: 'bullish',
      detail: `close ${today.toFixed(2)} > close 4d ago ${today4.toFixed(2)}, after bearish setup`, priority: 5 };
  }
  if (today < today4 && yest >= yest4) {
    return { rule: 'TD Price Flip (Bearish)', source: 'DeMark', signal: 'bearish',
      detail: `close ${today.toFixed(2)} < close 4d ago ${today4.toFixed(2)}, after bullish setup`, priority: 5 };
  }
  return null;
}

/**
 * TD Setup — counts consecutive closes vs the close 4 bars earlier.
 *   Buy Setup: 9 consecutive closes < close 4 bars ago. Day 1 preceded by bullish flip.
 *   Sell Setup: 9 consecutive closes > close 4 bars ago. Day 1 preceded by bearish flip.
 * Returns the CURRENT in-progress count (1-9). 9 = setup complete (short-term reversal).
 * Source: DeMark Ch 7 pp.140-156.
 */
function tdSetup(bars) {
  if (!bars || bars.length < 14) return null;
  const n = bars.length;
  const c = (i) => bars[i].Close;
  // Walk backward to count current streak vs close[i-4]
  let buyCount = 0, sellCount = 0;
  for (let i = n - 1; i >= 4; i--) {
    if (c(i) < c(i - 4)) {
      if (sellCount > 0) break;
      buyCount++;
    } else if (c(i) > c(i - 4)) {
      if (buyCount > 0) break;
      sellCount++;
    } else break;
  }
  if (buyCount < 4 && sellCount < 4) return null;
  if (buyCount >= 4) {
    const display = Math.min(buyCount, 9);
    const extended = buyCount > 13; // would normally have transitioned to countdown
    const complete = buyCount >= 9 && !extended;
    let perfect = false;
    if (complete && bars.length >= 9) {
      const low8 = bars[n - 2].Low, low9 = bars[n - 1].Low;
      const low6 = bars[n - 4].Low, low7 = bars[n - 3].Low;
      perfect = (low9 < low6 && low9 < low7) || (low8 < low6 && low8 < low7);
    }
    if (extended) return {
      rule: `TD Buy Setup Extended (${buyCount} bars)`, source: 'DeMark', signal: 'neutral',
      detail: `Setup ran past 9; persistent downtrend without intersection — wait for countdown`,
      priority: 4,
    };
    return {
      rule: complete ? `TD Buy Setup Complete${perfect ? ' (Perfected)' : ''}` : `TD Buy Setup ${display}/9`,
      source: 'DeMark', signal: 'bullish',
      detail: complete
        ? `9 consecutive closes < close 4 bars ago — expect short-term bottom`
        : `${display} of 9 closes < close 4 bars ago — building toward exhaustion`,
      priority: complete ? (perfect ? 9 : 8) : 6,
    };
  }
  if (sellCount >= 4) {
    const display = Math.min(sellCount, 9);
    const extended = sellCount > 13;
    const complete = sellCount >= 9 && !extended;
    let perfect = false;
    if (complete && bars.length >= 9) {
      const high8 = bars[n - 2].High, high9 = bars[n - 1].High;
      const high6 = bars[n - 4].High, high7 = bars[n - 3].High;
      perfect = (high9 > high6 && high9 > high7) || (high8 > high6 && high8 > high7);
    }
    if (extended) return {
      rule: `TD Sell Setup Extended (${sellCount} bars)`, source: 'DeMark', signal: 'neutral',
      detail: `Setup ran past 9; persistent uptrend without intersection — wait for countdown`,
      priority: 4,
    };
    return {
      rule: complete ? `TD Sell Setup Complete${perfect ? ' (Perfected)' : ''}` : `TD Sell Setup ${display}/9`,
      source: 'DeMark', signal: 'bearish',
      detail: complete
        ? `9 consecutive closes > close 4 bars ago — expect short-term top`
        : `${display} of 9 closes > close 4 bars ago — building toward exhaustion`,
      priority: complete ? (perfect ? 9 : 8) : 6,
    };
  }
  return null;
}

/**
 * TD Countdown — the deeper signal that fires after a Setup completes.
 *   Buy Countdown: 13 bars where Close[i] <= Low[i-2], starting AFTER day 9 of buy setup.
 *   Sell Countdown: 13 bars where Close[i] >= High[i-2], after day 9 of sell setup.
 * Bars need not be consecutive. ~15-30 days from setup start to countdown 13.
 * Completion = MAJOR REVERSAL signal.
 * Source: DeMark Ch 7 pp.156-181.
 */
function tdCountdown(bars) {
  if (!bars || bars.length < 35) return null;
  const n = bars.length;
  const c = (i) => bars[i].Close, h = (i) => bars[i].High, l = (i) => bars[i].Low;
  // Look back up to 50 bars for a recently completed setup (day 9 within last 30 bars)
  // Then count countdown bars from setup completion forward.
  let setupEnd = -1, setupKind = null;
  for (let end = n - 1; end >= Math.max(8, n - 35); end--) {
    // Check buy setup: closes[end-8..end] all < close[i-4]
    let bOk = true, sOk = true;
    for (let i = end - 8; i <= end && (bOk || sOk); i++) {
      if (i - 4 < 0) { bOk = false; sOk = false; break; }
      if (c(i) >= c(i - 4)) bOk = false;
      if (c(i) <= c(i - 4)) sOk = false;
    }
    if (bOk) { setupEnd = end; setupKind = 'buy'; break; }
    if (sOk) { setupEnd = end; setupKind = 'sell'; break; }
  }
  if (setupEnd < 0) return null;
  // Count countdown bars from setupEnd forward
  let count = 0;
  for (let i = setupEnd; i <= n - 1; i++) {
    if (i - 2 < 0) continue;
    if (setupKind === 'buy' && c(i) <= l(i - 2)) count++;
    else if (setupKind === 'sell' && c(i) >= h(i - 2)) count++;
  }
  if (count < 8) return null; // only flag once meaningfully along
  const complete = count >= 13;
  if (setupKind === 'buy') {
    return {
      rule: complete ? 'TD Buy Countdown Complete (13)' : `TD Buy Countdown (${count}/13)`,
      source: 'DeMark', signal: 'bullish',
      detail: `${count} closes ≤ low 2 bars ago since setup — major reversal at 13`,
      priority: complete ? 10 : 7,
    };
  }
  return {
    rule: complete ? 'TD Sell Countdown Complete (13)' : `TD Sell Countdown (${count}/13)`,
    source: 'DeMark', signal: 'bearish',
    detail: `${count} closes ≥ high 2 bars ago since setup — major reversal at 13`,
    priority: complete ? 10 : 7,
  };
}

/**
 * Waldo #2 — significant reversal close.
 *   Bullish: close greater than ALL previous 4 closes (after a downside reversal day).
 *   Bearish: close less than ALL previous 4 closes (after upside reversal).
 * Source: DeMark Ch 13, "Waldo Patterns" rule #2.
 */
function waldoFourCloseReversal(bars) {
  if (!bars || bars.length < 6) return null;
  const n = bars.length;
  const c = (i) => bars[i].Close, l = (i) => bars[i].Low, h = (i) => bars[i].High;
  const today = c(n - 1);
  const last4 = [c(n - 2), c(n - 3), c(n - 4), c(n - 5)];
  if (today > Math.max(...last4)) {
    // Confirm it follows a downside-reversal day (low < prev low, close < prev close) within last 5 bars
    let reversalDay = false;
    for (let i = n - 6; i < n - 1; i++) {
      if (i < 1) continue;
      if (l(i) < l(i - 1) && c(i) < c(i - 1)) { reversalDay = true; break; }
    }
    if (reversalDay) return {
      rule: 'Waldo Bullish 4-Close Reversal', source: 'DeMark', signal: 'bullish',
      detail: `close ${today.toFixed(2)} > all prior 4 closes after recent downside reversal`,
      priority: 6,
    };
  }
  if (today < Math.min(...last4)) {
    let reversalDay = false;
    for (let i = n - 6; i < n - 1; i++) {
      if (i < 1) continue;
      if (h(i) > h(i - 1) && c(i) > c(i - 1)) { reversalDay = true; break; }
    }
    if (reversalDay) return {
      rule: 'Waldo Bearish 4-Close Reversal', source: 'DeMark', signal: 'bearish',
      detail: `close ${today.toFixed(2)} < all prior 4 closes after recent upside reversal`,
      priority: 6,
    };
  }
  return null;
}

/**
 * Waldo #8 — short-term top/bottom via 7-vs-11 day asymmetric breakout.
 *   Top:    close[1d ago] < close[5d ago] AND today's close > all prev 7 days' highs
 *           BUT NOT all prev 11 days' highs → SHORT-TERM TOP
 *   Bottom: close[1d ago] > close[5d ago] AND today's close < all prev 7 days' lows
 *           BUT NOT all prev 11 days' lows → SHORT-TERM LOW
 * Source: DeMark Ch 13, Waldo rule #8.
 */
function waldoSevenEleven(bars) {
  if (!bars || bars.length < 13) return null;
  const n = bars.length;
  const c = (i) => bars[i].Close, h = (i) => bars[i].High, l = (i) => bars[i].Low;
  const today = c(n - 1), todayH = h(n - 1), todayL = l(n - 1);
  const cYest = c(n - 2), c5 = c(n - 6);
  const highs7 = []; for (let i = n - 8; i < n - 1; i++) highs7.push(h(i));
  const highs11 = []; for (let i = n - 12; i < n - 1; i++) highs11.push(h(i));
  const lows7 = []; for (let i = n - 8; i < n - 1; i++) lows7.push(l(i));
  const lows11 = []; for (let i = n - 12; i < n - 1; i++) lows11.push(l(i));
  if (cYest < c5 && today > Math.max(...highs7) && today < Math.max(...highs11)) {
    return {
      rule: 'Waldo Short-Term Top (7v11)', source: 'DeMark', signal: 'bearish',
      detail: `close > prev 7-day highs but not prev 11-day highs after weakness — exhaustion`,
      priority: 6,
    };
  }
  if (cYest > c5 && today < Math.min(...lows7) && today > Math.min(...lows11)) {
    return {
      rule: 'Waldo Short-Term Low (7v11)', source: 'DeMark', signal: 'bullish',
      detail: `close < prev 7-day lows but not prev 11-day lows after strength — exhaustion`,
      priority: 6,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FARLEY — The Master Swing Trader (McGraw-Hill 2001)
//
// Codifies Farley's 7-Bells framework + Pattern Cycle filters. Pure row-level
// rules use the ClickHouse daily row; setups that need a bar series (NR7,
// Hole-in-the-Wall gap detection) accept opts.bars (most recent LAST).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Farley 200d regime filter — "Bulls live above the 200-day, bears live below."
 * Hard regime line baked into all of his 7-Bells.
 */
function farley200dRegime(r) {
  if (!r.SMA_200 || !r.Close) return null;
  const distPct = (r.Close - r.SMA_200) / r.SMA_200;
  if (distPct > 0.02) {
    return { rule: 'Farley Bull Regime (>200d)', source: 'Farley', signal: 'bullish',
      detail: `Close ${(distPct * 100).toFixed(1)}% above 200d — buyers in control`, priority: 3 };
  }
  if (distPct < -0.02) {
    return { rule: 'Farley Bear Regime (<200d)', source: 'Farley', signal: 'bearish',
      detail: `Close ${(distPct * 100).toFixed(1)}% below 200d — sellers eat rallies`, priority: 3 };
  }
  return null;
}

/**
 * Farley MA Ribbon — daily 20/50/200 stack OR EMA 8/21/50 stack (Farley's faster set).
 * Stacked + rising = bull alignment. Inverted + falling = bear alignment.
 * Stronger than a single-MA read because it captures multi-timeframe agreement.
 */
function farleyMARibbon(r) {
  // Daily classic ribbon
  if (r.SMA_20 && r.SMA_50 && r.SMA_200) {
    const bull = r.SMA_20 > r.SMA_50 && r.SMA_50 > r.SMA_200
              && r.SMA_20_Slope1 > 0 && r.SMA_50_Slope1 > 0 && r.SMA_200_Slope1 > 0;
    const bear = r.SMA_20 < r.SMA_50 && r.SMA_50 < r.SMA_200
              && r.SMA_20_Slope1 < 0 && r.SMA_50_Slope1 < 0;
    if (bull) {
      return { rule: 'Farley Ribbon Bull Stack (20/50/200)', source: 'Farley', signal: 'bullish',
        detail: `Daily ribbon stacked + all rising — momentum confluence`, priority: 5 };
    }
    if (bear) {
      return { rule: 'Farley Ribbon Bear Stack (20/50/200)', source: 'Farley', signal: 'bearish',
        detail: `Daily ribbon inverted + falling — sellers in control`, priority: 5 };
    }
  }
  return null;
}

/**
 * Farley Power Spike — high-volume event flagged by ratio vs the running average.
 * Single-day: vol ≥ 3× avg. Tight filter: ≥ 5× = exhaustion (NOT continuation).
 * Type classified by price action: breakout / breakdown / climax / pivot.
 * Uses AvgVol_20 as the warehouse doesn't carry AvgVol_50 (close approximation).
 */
function farleyPowerSpike(r) {
  if (!r.Volume || !r.AvgVol_20 || r.AvgVol_20 <= 0) return null;
  const ratio = r.Volume / r.AvgVol_20;
  if (ratio < 3) return null;

  // 5x or more = exhaustion warning regardless of direction
  if (ratio >= 5) {
    const climaxLong = r.DayPct > 0.03 && r.RSI_14 > 70;
    const climaxShort = r.DayPct < -0.03 && r.RSI_14 < 30;
    if (climaxLong) {
      return { rule: 'Farley Climax Spike (Long Exhaustion)', source: 'Farley', signal: 'bearish',
        detail: `Vol ${ratio.toFixed(1)}× + RSI ${r.RSI_14.toFixed(0)} + ${(r.DayPct*100).toFixed(1)}% — sell the strength`,
        priority: 8 };
    }
    if (climaxShort) {
      return { rule: 'Farley Climax Spike (Short Exhaustion)', source: 'Farley', signal: 'bullish',
        detail: `Vol ${ratio.toFixed(1)}× + RSI ${r.RSI_14.toFixed(0)} + ${(r.DayPct*100).toFixed(1)}% — capitulation, fade the panic`,
        priority: 8 };
    }
    return { rule: 'Farley Power Spike Exhaustion', source: 'Farley', signal: 'neutral',
      detail: `Vol ${ratio.toFixed(1)}× avg — trend may FLATLINE, not continue`, priority: 5 };
  }

  // 3-5× = real spike, classify by direction + location
  if (r.DayPct > 0.02 && r.Is_20d_High) {
    return { rule: 'Farley Breakout Spike', source: 'Farley', signal: 'bullish',
      detail: `Vol ${ratio.toFixed(1)}× + ${(r.DayPct*100).toFixed(1)}% + 20d high — wait pullback for entry`,
      priority: 7 };
  }
  if (r.DayPct < -0.02 && r.Is_20d_Low) {
    return { rule: 'Farley Breakdown Spike', source: 'Farley', signal: 'bearish',
      detail: `Vol ${ratio.toFixed(1)}× + ${(r.DayPct*100).toFixed(1)}% + 20d low — short the pullback`,
      priority: 7 };
  }
  return { rule: 'Farley Power Spike (Unclassified)', source: 'Farley', signal: 'neutral',
    detail: `Vol ${ratio.toFixed(1)}× avg — pivot risk, wait for confirmation`, priority: 4 };
}

/**
 * Farley Dip Trip candidate — pullback to MA support in Stage 2 uptrend.
 * Proxies the "Fib retracement on declining volume" with:
 *   stage 2 (above rising 200d) + close near 20 SMA or 50 SMA
 *   + RSI in 35-50 (oversold but not broken) + volume < avg
 * Note: Holy Grail rule already covers 21 EMA pullback; this fires on the
 * deeper 50 SMA bounce zone which Farley calls out specifically.
 */
function farleyDipTrip(r) {
  if (!r.SMA_50 || !r.SMA_200 || !r.RSI_14 || !r.SMA_200_Slope1) return null;
  // Stage 2 prerequisite
  const stage2 = r.Close > r.SMA_200 && r.SMA_200_Slope1 > 0;
  if (!stage2) return null;
  // Volume dropoff prerequisite (selling drying up)
  const lowVol = r.AvgVol_20 > 0 && r.Volume / r.AvgVol_20 < 0.9;
  // RSI in dip-buy band
  const rsiOK = r.RSI_14 >= 35 && r.RSI_14 <= 50;
  if (!rsiOK || !lowVol) return null;
  // Within 2% of 50 SMA = Farley's deeper-dip zone
  const dist50 = Math.abs(r.Close - r.SMA_50) / r.SMA_50;
  if (dist50 < 0.025 && r.Close < r.SMA_20) {
    return { rule: 'Farley Dip Trip (50 SMA)', source: 'Farley', signal: 'bullish',
      detail: `Stage 2 pullback to 50 SMA + RSI ${r.RSI_14.toFixed(0)} + vol ${(r.Volume/r.AvgVol_20).toFixed(1)}× — bounce zone`,
      priority: 7 };
  }
  return null;
}

/**
 * Farley 3rd Watch — triple-top / cup-and-handle breakout.
 * Scannable parameters:
 *   - within 3% of High_252d (6-month high proxy; warehouse doesn't carry 126d)
 *   - flagging on the breakout bar: Is_20d_High AND price near 252d ceiling
 *   - volume ≥ 1.5× avg (Farley's minimum from O'Neill heritage)
 *   - rising 200d (must be in uptrend, not failing breakout)
 */
function farleyThirdWatch(r) {
  if (!r.Is_20d_High || !r.High_252d || !r.AvgVol_20) return null;
  if (!r.SMA_200_Slope1 || r.SMA_200_Slope1 <= 0) return null;
  const distFromHigh = (r.High_252d - r.Close) / r.High_252d;
  if (distFromHigh > 0.03) return null; // not at 6-12 month high
  const volRatio = r.Volume / r.AvgVol_20;
  if (volRatio < 1.5) return null;
  const quality = volRatio >= 2.5 ? 'A' : 'B';
  return { rule: 'Farley 3rd Watch Breakout', source: 'Farley', signal: 'bullish',
    detail: `${(distFromHigh*100).toFixed(1)}% from 52w high + vol ${volRatio.toFixed(1)}× + rising 200d (${quality} grade)`,
    priority: 9 };
}

/**
 * Farley NR7 (Coiled Spring) — current bar's range is the narrowest of the last 7 bars.
 * Bilateral trigger: trade in whichever direction price exits the NR7 range.
 * Requires bar series with High/Low.
 */
function farleyNR7(bars) {
  if (!bars || bars.length < 7) return null;
  const n = bars.length;
  const range = (b) => (b.High - b.Low);
  const today = range(bars[n - 1]);
  if (today <= 0) return null;
  for (let i = n - 8; i < n - 1; i++) {
    if (i < 0) return null;
    if (range(bars[i]) <= today) return null;
  }
  // Confirm NR7 — check NR7-2 (two narrow bars in a row)
  let nr72 = false;
  if (n >= 8) {
    const yest = range(bars[n - 2]);
    let isYestNR7 = true;
    for (let i = n - 9; i < n - 2; i++) {
      if (i < 0) { isYestNR7 = false; break; }
      if (range(bars[i]) <= yest) { isYestNR7 = false; break; }
    }
    nr72 = isYestNR7;
  }
  const last = bars[n - 1];
  return {
    rule: nr72 ? 'Farley Coiled Spring (NR7-2)' : 'Farley Coiled Spring (NR7)',
    source: 'Farley',
    signal: 'neutral',
    detail: nr72
      ? `Two narrow bars in a row (range ${today.toFixed(2)}) — bilateral entry: buy stop ${last.High.toFixed(2)}, sell stop ${last.Low.toFixed(2)}`
      : `Narrowest range of last 7 bars (${today.toFixed(2)}) — bilateral entry: buy stop ${last.High.toFixed(2)}, sell stop ${last.Low.toFixed(2)}`,
    priority: nr72 ? 8 : 6,
  };
}

/**
 * Farley Hole-in-the-Wall — down-gap after a strong rally that breaks 20 + 50 SMA in one bar.
 * Trade mechanics: gap should NOT fill, especially after first 60min;
 *   look for short entry on bounce into the gap.
 * Requires bar series (need prior bar to compute gap) + the daily row (for MAs).
 */
function farleyHoleInWall(bars, r) {
  if (!bars || bars.length < 22 || !r) return null;
  if (!r.SMA_20 || !r.SMA_50) return null;
  const n = bars.length;
  const today = bars[n - 1], yest = bars[n - 2];
  // Gap = today.Open < yest.Low (real down-gap, not partial)
  if (today.Open >= yest.Low) return null;
  const gapPct = (yest.Low - today.Open) / yest.Low;
  if (gapPct < 0.015) return null; // ≥1.5% gap to count
  // Today closes below both 20 and 50 SMA = key Farley signal
  if (today.Close >= r.SMA_20 || today.Close >= r.SMA_50) return null;
  // Prior context: must have been in a rally — yesterday's close > 20-day prior close
  const c20 = bars[Math.max(0, n - 22)].Close;
  if (yest.Close <= c20 * 1.05) return null; // need at least 5% prior rally
  return {
    rule: 'Farley Hole-in-the-Wall',
    source: 'Farley',
    signal: 'bearish',
    detail: `Gap-down ${(gapPct*100).toFixed(1)}% after rally + closed below both 20 + 50 SMA — short bounces into gap`,
    priority: 9,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FISCHER — Fibonacci Applications and Strategies for Traders (Wiley 1993)
//
// Strips out Elliott's wave-count subjectivity; keeps the 0.618 / 1.618 ratios
// applied to detected swing pivots. Provides PRICE-anchored targets (not
// ATR-multiples) and a TIME axis (TGD = B + 1.618 × (B - A)).
//
// All Fischer rules consume the bar series via opts.bars. A swing-pivot
// detector (fractal method) does the heavy lifting; downstream rules read its
// output. Designed so confluence.mjs can call findSwingPivots() directly to
// replace ATR-based t1/t2 with structure-anchored targets.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fractal swing-pivot detector. A bar at index i is a:
 *   PEAK   if  High[i]  > High[i-N..i-1]  AND  High[i]  > High[i+1..i+N]
 *   VALLEY if  Low[i]   < Low[i-N..i-1]   AND  Low[i]   < Low[i+1..i+N]
 * Returns an array of pivots ordered oldest → newest. The newest pivot
 * cannot be the very last N bars (still in the "right shoulder" zone).
 * @param {Array} bars — recent LAST
 * @param {number} window — N bars on each side to confirm a fractal (default 3)
 * @returns {Array<{idx:number, type:'peak'|'valley', price:number, ts:any}>}
 */
export function findSwingPivots(bars, window = 3) {
  if (!bars || bars.length < window * 2 + 1) return [];
  const pivots = [];
  for (let i = window; i < bars.length - window; i++) {
    const b = bars[i];
    let isPeak = true, isValley = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (bars[j].High >= b.High) isPeak = false;
      if (bars[j].Low <= b.Low) isValley = false;
      if (!isPeak && !isValley) break;
    }
    if (isPeak) pivots.push({ idx: i, type: 'peak', price: b.High, ts: b.Timestamp });
    if (isValley) pivots.push({ idx: i, type: 'valley', price: b.Low, ts: b.Timestamp });
  }
  // Filter out adjacent same-type pivots (keep the more extreme one)
  const filtered = [];
  for (const p of pivots) {
    const last = filtered[filtered.length - 1];
    if (!last || last.type !== p.type) {
      filtered.push(p);
    } else if (p.type === 'peak' && p.price > last.price) {
      filtered[filtered.length - 1] = p;
    } else if (p.type === 'valley' && p.price < last.price) {
      filtered[filtered.length - 1] = p;
    }
  }
  return filtered;
}

/**
 * Compute Fisher swing target structure for the current direction.
 * Given the most recent valley→peak (or peak→valley) sequence in the bar
 * series, returns the retracement bands, extension targets, profit target,
 * and time goal day.
 *
 * @param {Array} bars — recent LAST, ≥ 30 bars
 * @returns {Object|null} — {
 *   direction:'long'|'short',
 *   wave1Start, wave1End, wave1Amplitude,
 *   retracements: { '38': price, '50': price, '62': price },
 *   profitTarget:   number,  // entry + 0.618 × amplitude
 *   extensionTargets: { '127': price, '162': price, '262': price },
 *   tgd: { bars: number, dateOffset: number },  // Time Goal Day (in bars from now)
 *   currentRetracementPct: number,  // where price is now in the pullback
 * }
 */
export function fisherSwingTarget(bars) {
  if (!bars || bars.length < 30) return null;
  const pivots = findSwingPivots(bars, 3);
  if (pivots.length < 2) return null;
  // Take the most recent two pivots as wave 1
  const recent = pivots.slice(-2);
  const [p1, p2] = recent;
  if (p1.type === p2.type) return null; // can't form a swing
  const direction = p2.type === 'peak' ? 'long' : 'short';
  const wave1Start = p1.price;
  const wave1End = p2.price;
  const wave1Amplitude = Math.abs(wave1End - wave1Start);
  if (wave1Amplitude <= 0) return null;
  const now = bars[bars.length - 1].Close;
  const sign = direction === 'long' ? 1 : -1;

  // Retracements measured from wave1End back toward wave1Start
  const retracements = {
    '38': wave1End - sign * 0.382 * wave1Amplitude,
    '50': wave1End - sign * 0.500 * wave1Amplitude,
    '62': wave1End - sign * 0.618 * wave1Amplitude,
  };
  // Where is the current close in the pullback? (0% = at wave1End, 100% = at wave1Start)
  const currentRetracementPct = ((wave1End - now) / (wave1End - wave1Start)) * 100;

  // Profit target: entry (current close) + 0.618 × wave1 amplitude
  const profitTarget = now + sign * 0.618 * wave1Amplitude;

  // Extension targets — measured from wave1Start, projected by 1.272/1.618/2.618 × amplitude
  const extensionTargets = {
    '127': wave1Start + sign * 1.272 * wave1Amplitude,
    '162': wave1Start + sign * 1.618 * wave1Amplitude,
    '262': wave1Start + sign * 2.618 * wave1Amplitude,
  };

  // Time Goal Day: TGD = p2.idx + 1.618 × (p2.idx - p1.idx)
  const barsBetween = p2.idx - p1.idx;
  const tgdIdx = p2.idx + Math.round(1.618 * barsBetween);
  const barsFromNow = tgdIdx - (bars.length - 1);

  return {
    direction,
    wave1Start, wave1End, wave1Amplitude,
    retracements, profitTarget, extensionTargets,
    tgd: { idx: tgdIdx, barsFromNow },
    currentRetracementPct: Math.round(currentRetracementPct * 10) / 10,
    pivots: { wave1Start: p1, wave1End: p2 },
  };
}

/**
 * Fisher Retracement Zone — fires when price is in the 38/50/62 band
 * AND the entry confirmation triggers.
 *   Long confirmation: today's Close > High of the lowest bar in the pullback
 *   Short confirmation: today's Close < Low of the highest bar in the bounce
 */
function fisherRetracement(bars) {
  const target = fisherSwingTarget(bars);
  if (!target) return null;
  const now = bars[bars.length - 1];
  const pct = target.currentRetracementPct;
  // Only fire when we're inside the 30-70% retracement band (the 38-62 zone with tolerance)
  if (pct < 30 || pct > 70) return null;
  // Identify which Fib level is closest
  let level = '50';
  let levelPrice = target.retracements['50'];
  for (const lvl of ['38', '50', '62']) {
    if (Math.abs(now.Close - target.retracements[lvl]) < Math.abs(now.Close - levelPrice)) {
      level = lvl;
      levelPrice = target.retracements[lvl];
    }
  }
  // Check entry confirmation (close beyond the high/low of the extreme bar in the pullback)
  // Walk back through the pullback (from wave1End forward in bars) to find extreme bar
  const startIdx = target.pivots.wave1End.idx;
  let extremeBarIdx = startIdx;
  if (target.direction === 'long') {
    let lowest = bars[startIdx].Low;
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].Low < lowest) { lowest = bars[i].Low; extremeBarIdx = i; }
    }
    const confirmed = now.Close > bars[extremeBarIdx].High;
    if (!confirmed) return null;
    return {
      rule: `Fisher Retracement Long (${level}%)`,
      source: 'Fischer',
      signal: 'bullish',
      detail: `pullback ${pct.toFixed(0)}% (${level}% Fib at ${levelPrice.toFixed(2)}); close > extreme-bar high — entry confirmed; T1 ${target.profitTarget.toFixed(2)}, T2 (1.618 ext) ${target.extensionTargets['162'].toFixed(2)}`,
      priority: 8,
    };
  } else {
    let highest = bars[startIdx].High;
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].High > highest) { highest = bars[i].High; extremeBarIdx = i; }
    }
    const confirmed = now.Close < bars[extremeBarIdx].Low;
    if (!confirmed) return null;
    return {
      rule: `Fisher Retracement Short (${level}%)`,
      source: 'Fischer',
      signal: 'bearish',
      detail: `bounce ${pct.toFixed(0)}% (${level}% Fib at ${levelPrice.toFixed(2)}); close < extreme-bar low — entry confirmed; T1 ${target.profitTarget.toFixed(2)}, T2 (1.618 ext) ${target.extensionTargets['162'].toFixed(2)}`,
      priority: 8,
    };
  }
}

/**
 * Fisher Extension Reversal — fires when price approaches a 1.618 extension
 * AND begins to show reversal confirmation. This is the "sell wave 3 top /
 * buy wave 5 bottom" trade.
 */
function fisherExtensionReversal(bars) {
  const target = fisherSwingTarget(bars);
  if (!target) return null;
  const now = bars[bars.length - 1];
  // Check if we're at or beyond the 1.618 extension (within 2% tolerance)
  const ext162 = target.extensionTargets['162'];
  const ext127 = target.extensionTargets['127'];
  const tolerance = Math.abs(target.wave1Amplitude) * 0.05;
  // For a long sequence (wave1 was a rally), price NOW near or above 1.618 = exhaustion top → short
  if (target.direction === 'long' && now.Close >= ext127 - tolerance && now.Close <= ext162 + tolerance) {
    // Need reversal confirmation: close < low of the highest bar in the extension
    const startIdx = target.pivots.wave1End.idx;
    let highBarIdx = startIdx;
    let highestHigh = bars[startIdx].High;
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].High > highestHigh) { highestHigh = bars[i].High; highBarIdx = i; }
    }
    if (now.Close < bars[highBarIdx].Low) {
      const which = now.Close > (ext127 + ext162) / 2 ? '1.618' : '1.272';
      return {
        rule: `Fisher Extension Reversal (Short @ ${which})`,
        source: 'Fischer',
        signal: 'bearish',
        detail: `price hit ${which} extension (${(which === '1.618' ? ext162 : ext127).toFixed(2)}); close < high-bar low — exhaustion confirmed`,
        priority: 8,
      };
    }
  }
  // For a short sequence (wave1 was a decline), price NOW near or below 1.618 = exhaustion bottom → long
  if (target.direction === 'short' && now.Close <= ext127 + tolerance && now.Close >= ext162 - tolerance) {
    const startIdx = target.pivots.wave1End.idx;
    let lowBarIdx = startIdx;
    let lowestLow = bars[startIdx].Low;
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i].Low < lowestLow) { lowestLow = bars[i].Low; lowBarIdx = i; }
    }
    if (now.Close > bars[lowBarIdx].High) {
      const which = now.Close < (ext127 + ext162) / 2 ? '1.618' : '1.272';
      return {
        rule: `Fisher Extension Reversal (Long @ ${which})`,
        source: 'Fischer',
        signal: 'bullish',
        detail: `price hit ${which} extension (${(which === '1.618' ? ext162 : ext127).toFixed(2)}); close > low-bar high — capitulation confirmed`,
        priority: 8,
      };
    }
  }
  return null;
}

/**
 * Fisher Time Goal Day proximity — informational signal when we're within
 * 3 bars of a projected TGD. Combined with a Fib price level = price-time
 * cross (Fischer's highest-conviction reversal).
 */
function fisherTimeGoalDay(bars) {
  const target = fisherSwingTarget(bars);
  if (!target) return null;
  const dist = Math.abs(target.tgd.barsFromNow);
  if (dist > 3) return null;
  // Only flag if we're also near a Fib retracement (=> price-time cross)
  const pct = target.currentRetracementPct;
  const nearFibRetrace = (pct >= 33 && pct <= 43) || (pct >= 47 && pct <= 53) || (pct >= 57 && pct <= 67);
  // Or near an extension
  const ext162 = target.extensionTargets['162'];
  const tolerance = target.wave1Amplitude * 0.04;
  const now = bars[bars.length - 1].Close;
  const nearExt = Math.abs(now - ext162) <= tolerance;
  if (!nearFibRetrace && !nearExt) return null;
  return {
    rule: 'Fisher Price-Time Cross',
    source: 'Fischer',
    signal: target.direction === 'long' ? 'bullish' : 'bearish',
    detail: `TGD ${target.tgd.barsFromNow >= 0 ? 'in '+target.tgd.barsFromNow : Math.abs(target.tgd.barsFromNow)+' bars ago'} + Fib ${nearExt ? '1.618 extension' : pct.toFixed(0)+'% retracement'} — highest-conviction reversal zone`,
    priority: 9,
  };
}

/**
 * Apply all book rules to a ClickHouse daily_ohlcv row.
 * @param {Object} r — ClickHouse row with all pre-computed columns
 * @param {Object} [opts]
 * @param {Array}  [opts.bars] — Optional series of recent bars (most recent LAST)
 *                               for DeMark rules. Need ≥35 bars for Countdown.
 * @returns {Object[]} Array of { rule, source, signal, detail, priority }
 */
export function applyBookRules(r, opts = {}) {
  if (!r) return [];

  const bars = opts.bars || null;

  const results = [
    weinsteinStage(r),
    weinsteinBreakout(r),
    bollingerSqueeze(r),
    bollingerWalk(r),
    bollingerPctB(r),
    macdDivergence(r),
    macdZeroCross(r),
    rsiRegime(r),
    elderTripleScreen(r),
    holyGrail(r),
    idNR4(r),
    maAlignment(r),
    volumeConfirmation(r),
    riskCheck(r),
    // DeMark rules (skipped if no bars passed)
    bars ? tdPriceFlip(bars) : null,
    bars ? tdSetup(bars) : null,
    bars ? tdCountdown(bars) : null,
    bars ? waldoFourCloseReversal(bars) : null,
    bars ? waldoSevenEleven(bars) : null,
    // Farley 7-Bells + Pattern Cycle
    farley200dRegime(r),
    farleyMARibbon(r),
    farleyPowerSpike(r),
    farleyDipTrip(r),
    farleyThirdWatch(r),
    bars ? farleyNR7(bars) : null,
    bars ? farleyHoleInWall(bars, r) : null,
    // Fischer Fibonacci (all need bar series for swing-pivot detection)
    bars ? fisherRetracement(bars) : null,
    bars ? fisherExtensionReversal(bars) : null,
    bars ? fisherTimeGoalDay(bars) : null,
  ].filter(Boolean);

  // Sort by priority (highest first)
  results.sort((a, b) => b.priority - a.priority);
  return results;
}

/**
 * Quick regime classification for a ticker.
 * @returns {'bullish'|'bearish'|'neutral'}
 */
export function classifyRegime(r) {
  if (!r) return 'neutral';
  const rules = applyBookRules(r);
  let bull = 0, bear = 0;
  for (const rule of rules) {
    if (rule.signal === 'bullish') bull += rule.priority;
    if (rule.signal === 'bearish') bear += rule.priority;
  }
  if (bull > bear * 1.5) return 'bullish';
  if (bear > bull * 1.5) return 'bearish';
  return 'neutral';
}

/**
 * Get Weinstein stage number (1-4) for a ticker.
 */
export function getStage(r) {
  const result = weinsteinStage(r);
  return result ? parseInt(result.rule.replace('Weinstein Stage ', '')) : null;
}
