// ============================================================
// [실험용 B안] 눌림목 매수 - 돌파(신고가 추격) 대신, 이미 확인된
// 상승추세에서 20일선까지 눌렸다가 되돌리는 시점에 매수.
// 청산은 A안과 동일하게 트레일링 스탑(15%) 사용 - "진입 스타일" 차이만
// 비교하기 위해 청산 로직은 고정.
// 프로토타입 - 검증 전까지 프로덕션 미반영.
// ============================================================

const {
  classifyMarketRegime,
  checkTrendTemplate,
  CONFIG,
} = require('./indicators');

const MAX_HOLD_DAYS = 90;
const PULLBACK_MA_PERIOD = 20;
const PULLBACK_BAND = 0.03;        // 20일선 대비 ±3% 이내를 "눌림"으로 판정
const SWING_LOOKBACK = 10;         // 손절선 계산용 최근 저점 구간
const FALLBACK_STOP_PCT = -0.08;   // 스윙저점을 못 구하거나 너무 멀면 대체 손절폭

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function runPullbackBacktest({ dates, opens, highs, lows, closes, volumes, indexCloses, trailStopPct = 0.15 }) {
  const n = closes.length;
  const trendTemplateNeed = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;
  const minLookback = trendTemplateNeed + 1;
  const trades = [];
  let inPosition = false;
  let entry = null;

  for (let i = minLookback; i < n - 1; i++) {
    const closesSlice = closes.slice(0, i + 1);
    const indexSlice = indexCloses.slice(0, i + 1);
    const regime = classifyMarketRegime(indexSlice);

    if (!inPosition) {
      const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';
      const trendOk = checkTrendTemplate(closesSlice) === true; // 이미 확립된 상승추세만 대상
      const ma20 = sma(closesSlice, PULLBACK_MA_PERIOD);
      const today = closes[i];
      const yesterday = closes[i - 1];
      const nearMa20 = ma20 !== null && today >= ma20 * (1 - PULLBACK_BAND) && today <= ma20 * (1 + PULLBACK_BAND);
      const bounceConfirmed = today > yesterday; // 눌렸다가 다시 오르는 첫날

      if (regimeOk && trendOk && nearMa20 && bounceConfirmed) {
        const swingLows = lows.slice(Math.max(0, i - SWING_LOOKBACK + 1), i + 1);
        const swingLow = swingLows.length ? Math.min(...swingLows) : null;
        const entryPrice = opens[i + 1];
        let stopLoss = entryPrice * (1 + FALLBACK_STOP_PCT);
        let stopLossBasis = 'percent';
        if (swingLow !== null) {
          const swingPct = swingLow / entryPrice - 1;
          if (swingPct >= FALLBACK_STOP_PCT) {
            stopLoss = swingLow;
            stopLossBasis = 'swing_low';
          }
        }
        entry = {
          entryIndex: i + 1,
          entryDate: dates[i + 1],
          entryPrice,
          stopLoss,
          stopLossBasis,
          peakClose: entryPrice,
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

module.exports = { runPullbackBacktest };
