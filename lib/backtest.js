// ============================================================
// 돌파매매 백테스터 (2단계)
// 스크리너와 동일한 lib/indicators.js 로직을 과거 데이터에 그대로
// 적용해서 "이 조건으로 매수했으면 실제로 어땠는지"를 계산합니다.
// 스크리너 조건이 바뀌면 백테스터도 자동으로 같이 바뀝니다.
// ============================================================

const {
  classifyMarketRegime,
  checkBreakout,
  volumeSurgeRatio,
  distanceFromFiftyTwoWeekHigh,
  CONFIG,
} = require('./indicators');

const MAX_HOLD_DAYS = 90; // 안전장치: 이 기간 넘게 보유 중이면 시장가 청산

/**
 * closes/highs/lows/volumes/dates: 종목 OHLCV (오래된 → 최신 순)
 * opens: 종목 시가 (진입가 계산용)
 * indexCloses: 기준 지수 종가 (같은 기간, 같은 길이) - 시장 국면 판별용
 */
function runBreakoutBacktest({ dates, opens, highs, lows, closes, volumes, indexCloses }) {
  const n = closes.length;
  const minLookback = CONFIG.breakoutLookback + 1; // 36주 신고가·전고점 돌파 계산에 필요한 최소 기간
  const trades = [];
  let inPosition = false;
  let entry = null;

  for (let i = minLookback; i < n - 1; i++) {
    const closesSlice = closes.slice(0, i + 1);
    const highsSlice = highs.slice(0, i + 1);
    const volumesSlice = volumes.slice(0, i + 1);
    const indexSlice = indexCloses.slice(0, i + 1);
    const regime = classifyMarketRegime(indexSlice);

    if (!inPosition) {
      const breakout = checkBreakout(highsSlice, closesSlice);
      const volRatio = volumeSurgeRatio(volumesSlice);
      const highDistance = distanceFromFiftyTwoWeekHigh(highsSlice, closesSlice);

      const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';
      const volumeOk = volRatio !== null && volRatio >= CONFIG.volumeSurgeMultiple;
      const nearHighOk = highDistance !== null && highDistance >= CONFIG.nearHighThreshold;

      if (regimeOk && breakout.isBreakout && volumeOk && nearHighOk) {
        // 다음날 시가에 진입한다고 가정
        entry = {
          entryIndex: i + 1,
          entryDate: dates[i + 1],
          entryPrice: opens[i + 1],
          stopLoss: breakout.stopLossLevel,
          breakoutLevel: breakout.breakoutLevel,
        };
        inPosition = true;
      }
    } else {
      const holdDays = i - entry.entryIndex;
      if (lows[i] <= entry.stopLoss) {
        trades.push(closeTrade(entry, dates[i], entry.stopLoss, 'stop_loss', holdDays));
        inPosition = false; entry = null;
      } else if (regime === 'DOWN') {
        trades.push(closeTrade(entry, dates[i], opens[i], 'regime_down', holdDays));
        inPosition = false; entry = null;
      } else if (holdDays >= MAX_HOLD_DAYS) {
        trades.push(closeTrade(entry, dates[i], closes[i], 'max_hold', holdDays));
        inPosition = false; entry = null;
      }
    }
  }

  // 백테스트 종료 시점까지 포지션이 남아있으면 마지막 종가로 청산 처리(미실현 손익 참고용)
  if (inPosition) {
    const lastIdx = n - 1;
    trades.push(closeTrade(entry, dates[lastIdx], closes[lastIdx], 'still_open', lastIdx - entry.entryIndex));
  }

  return summarize(trades);
}

function closeTrade(entry, exitDate, exitPrice, reason, holdDays) {
  const returnPct = exitPrice / entry.entryPrice - 1;
  return {
    entryDate: entry.entryDate,
    entryPrice: round(entry.entryPrice),
    exitDate,
    exitPrice: round(exitPrice),
    stopLoss: round(entry.stopLoss),
    reason,
    holdDays,
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

  // 매 거래마다 자본 전액을 순차 재투자한다고 가정한 복리 수익률 + 최대낙폭(MDD)
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
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
      maxDrawdownPct: round(maxDrawdown * 100, 1),
      exitReasonCounts: trades.reduce((acc, t) => {
        acc[t.reason] = (acc[t.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = { runBreakoutBacktest };
