// ============================================================
// [실험용 C안] 선별 강화 - 기존 돌파 조건은 그대로 두고,
// "종목 자체가 지수 대비 얼마나 강한가"(60일 수익률 - 지수 60일 수익률)
// 필터를 추가해 진짜 주도주만 거르는 버전.
// (진짜 RS Rating은 스캔 종목군 전체를 동시에 봐야 계산 가능해서
//  단일종목 백테스트 구조상 여기서는 "지수 대비 초과수익"으로 근사함)
// 청산은 A/B안과 동일하게 트레일링 스탑 사용 - 진입 스타일만 비교.
// 프로토타입 - 검증 전까지 프로덕션 미반영.
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
const RS_LOOKBACK = 60;         // 상대강도 계산 기간
const RS_MIN_EXCESS = 0.10;     // 지수 대비 최소 초과수익 (10%p 이상 아웃퍼폼해야 "주도주"로 인정)

function runSelectiveBacktest({ dates, opens, highs, lows, closes, volumes, indexCloses, lookback, trailStopPct = 0.15 }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const n = closes.length;
  const trendTemplateNeed = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;
  const minLookback = Math.max(effectiveLookback, trendTemplateNeed, RS_LOOKBACK) + 1;
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

      const stockRet = closes[i] / closes[i - RS_LOOKBACK] - 1;
      const idxRet = indexCloses[i] / indexCloses[i - RS_LOOKBACK] - 1;
      const rsExcessOk = (stockRet - idxRet) >= RS_MIN_EXCESS;

      if (regimeOk && breakout.isBreakout && volumeOk && nearHighOk && trendTemplateOk && rsExcessOk) {
        entry = {
          entryIndex: i + 1, entryDate: dates[i + 1], entryPrice: opens[i + 1],
          stopLoss: breakout.stopLossLevel, stopLossBasis: breakout.stopLossBasis,
          peakClose: opens[i + 1],
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
      entry.peakClose = Math.max(entry.peakClose, closes[i]);
      const trailingLevel = entry.peakClose * (1 - trailStopPct);
      if (closes[i] <= trailingLevel) {
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
    entryDate: entry.entryDate, entryPrice: round(entry.entryPrice), exitDate,
    exitPrice: round(exitPrice), stopLoss: round(entry.stopLoss), stopLossBasis: entry.stopLossBasis,
    reason, holdDays,
    grossReturnPct: round(grossReturnPct * 100, 2), returnPct: round(returnPct * 100, 2),
  };
}

function round(v, digits = 2) { const m = Math.pow(10, digits); return Math.round(v * m) / m; }

function summarize(trades) {
  if (!trades.length) return { trades: [], summary: { totalTrades: 0, message: '조건을 만족하는 거래가 없었습니다.' } };
  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const profitFactor = losses.length
    ? Math.abs(wins.reduce((a, t) => a + t.returnPct, 0) / losses.reduce((a, t) => a + t.returnPct, 0)) : null;
  let equity = 1, peak = 1, maxDrawdown = 0, grossEquity = 1;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    grossEquity *= 1 + t.grossReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peak) / peak);
  }
  return {
    trades,
    summary: {
      totalTrades: trades.length, winRate: round(winRate, 1), avgWinPct: round(avgWin, 2), avgLossPct: round(avgLoss, 2),
      profitFactor: profitFactor !== null ? round(profitFactor, 2) : null,
      compoundedReturnPct: round((equity - 1) * 100, 1),
      grossCompoundedReturnPct: round((grossEquity - 1) * 100, 1),
      tradingCostDragPct: round((grossEquity - equity) / grossEquity * 100, 1),
      maxDrawdownPct: round(maxDrawdown * 100, 1),
      exitReasonCounts: trades.reduce((acc, t) => { acc[t.reason] = (acc[t.reason] || 0) + 1; return acc; }, {}),
    },
  };
}

module.exports = { runSelectiveBacktest };
