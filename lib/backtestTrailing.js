// ============================================================
// [실험용 A안] 트레일링 스탑 청산 - 국면(DOWN) 이분법 즉시청산 대신
// "고점 대비 -X%" 트레일링 스탑으로 청산 기준을 완화한 버전.
// 초기 손절선(베이스 하단/%)은 기존과 동일하게 유지 - 최초 리스크 방어는 그대로.
// 국면은 신규 진입 필터로만 계속 사용(하락장에서 새로 사지 않음), 청산 트리거에서는 제외.
// lib/backtest.js와 A/B 비교하기 위한 프로토타입이며, 검증 전까지 프로덕션에는 반영하지 않음.
// ============================================================

const {
  classifyMarketRegime,
  checkBreakout,
  volumeSurgeRatio,
  distanceFromFiftyTwoWeekHigh,
  checkTrendTemplate,
  CONFIG,
} = require('./indicators');

const MAX_HOLD_DAYS = 90;

function runTrailingStopBacktest({ dates, opens, highs, lows, closes, volumes, indexCloses, lookback, trailStopPct = 0.15 }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const n = closes.length;
  const trendTemplateNeed = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;
  const minLookback = Math.max(effectiveLookback, trendTemplateNeed) + 1;
  const trades = [];
  let inPosition = false;
  let entry = null;

  for (let i = minLookback; i < n - 1; i++) {
    const closesSlice = closes.slice(0, i + 1);
    const highsSlice = highs.slice(0, i + 1);
    const volumesSlice = volumes.slice(0, i + 1);
    const lowsSlice = lows.slice(0, i + 1);
    const indexSlice = indexCloses.slice(0, i + 1);
    const regime = classifyMarketRegime(indexSlice);

    if (!inPosition) {
      const breakout = checkBreakout(highsSlice, closesSlice, lowsSlice, effectiveLookback);
      const volRatio = volumeSurgeRatio(volumesSlice);
      const highDistance = distanceFromFiftyTwoWeekHigh(highsSlice, closesSlice, effectiveLookback);
      const trendOk = checkTrendTemplate(closesSlice);

      const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';
      const volumeOk = volRatio !== null && volRatio >= CONFIG.volumeSurgeMultiple;
      const nearHighOk = highDistance !== null && highDistance >= CONFIG.nearHighThreshold;
      const trendTemplateOk = trendOk === true;

      if (regimeOk && breakout.isBreakout && volumeOk && nearHighOk && trendTemplateOk) {
        entry = {
          entryIndex: i + 1,
          entryDate: dates[i + 1],
          entryPrice: opens[i + 1],
          stopLoss: breakout.stopLossLevel,
          stopLossBasis: breakout.stopLossBasis,
          breakoutLevel: breakout.breakoutLevel,
          peakClose: opens[i + 1], // 진입 시가를 초기 고점으로 시작
        };
        inPosition = true;
      }
    } else {
      const holdDays = i - entry.entryIndex;
      if (opens[i] <= entry.stopLoss) {
        trades.push(closeTrade(entry, dates[i], opens[i], 'stop_loss_gap', holdDays));
        inPosition = false; entry = null;
        continue;
      }
      if (lows[i] <= entry.stopLoss) {
        trades.push(closeTrade(entry, dates[i], entry.stopLoss, 'stop_loss', holdDays));
        inPosition = false; entry = null;
        continue;
      }
      // 고점 갱신은 초기 손절 체크 이후, 트레일링 판정 이전에 - 오늘 종가 기준
      entry.peakClose = Math.max(entry.peakClose, closes[i]);
      const trailingLevel = entry.peakClose * (1 - trailStopPct);
      if (closes[i] <= trailingLevel) {
        // 오늘 종가로 트레일링 이탈 판정 -> 익일 시가 체결 (진입/regime_down 청산과 동일 원칙, 룩어헤드 방지)
        trades.push(closeTrade(entry, dates[i + 1], opens[i + 1], 'trailing_stop', holdDays + 1));
        inPosition = false; entry = null;
        continue;
      }
      if (holdDays >= MAX_HOLD_DAYS) {
        trades.push(closeTrade(entry, dates[i], closes[i], 'max_hold', holdDays));
        inPosition = false; entry = null;
      }
    }
  }

  if (inPosition) {
    const lastIdx = n - 1;
    trades.push(closeTrade(entry, dates[lastIdx], closes[lastIdx], 'still_open', lastIdx - entry.entryIndex));
  }

  return summarize(trades);
}

function closeTrade(entry, exitDate, exitPrice, reason, holdDays) {
  const cost = CONFIG.oneWayTradingCostPct;
  const effectiveEntryPrice = entry.entryPrice * (1 + cost);
  const effectiveExitPrice = exitPrice * (1 - cost);
  const grossReturnPct = exitPrice / entry.entryPrice - 1;
  const returnPct = effectiveExitPrice / effectiveEntryPrice - 1;
  return {
    entryDate: entry.entryDate,
    entryPrice: round(entry.entryPrice),
    exitDate,
    exitPrice: round(exitPrice),
    stopLoss: round(entry.stopLoss),
    stopLossBasis: entry.stopLossBasis,
    reason,
    holdDays,
    grossReturnPct: round(grossReturnPct * 100, 2),
    returnPct: round(returnPct * 100, 2),
  };
}

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function summarize(trades) {
  if (!trades.length) {
    return { trades: [], summary: { totalTrades: 0, message: '조건을 만족하는 거래가 없었습니다.' } };
  }
  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const profitFactor = losses.length
    ? Math.abs(wins.reduce((a, t) => a + t.returnPct, 0) / losses.reduce((a, t) => a + t.returnPct, 0))
    : null;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossEquity = 1;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    grossEquity *= 1 + t.grossReturnPct / 100;
    peak = Math.max(peak, equity);
    const dd = (equity - peak) / peak;
    maxDrawdown = Math.min(maxDrawdown, dd);
  }

  return {
    trades,
    summary: {
      totalTrades: trades.length,
      winRate: round(winRate, 1),
      avgWinPct: round(avgWin, 2),
      avgLossPct: round(avgLoss, 2),
      profitFactor: profitFactor !== null ? round(profitFactor, 2) : null,
      compoundedReturnPct: round((equity - 1) * 100, 1),
      grossCompoundedReturnPct: round((grossEquity - 1) * 100, 1),
      tradingCostDragPct: round((grossEquity - equity) / grossEquity * 100, 1),
      maxDrawdownPct: round(maxDrawdown * 100, 1),
      exitReasonCounts: trades.reduce((acc, t) => {
        acc[t.reason] = (acc[t.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = { runTrailingStopBacktest };
