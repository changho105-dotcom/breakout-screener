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
  checkTrendTemplate,
  CONFIG,
} = require('./indicators');

const MAX_HOLD_DAYS = 90; // 안전장치: 이 기간 넘게 보유 중이면 시장가 청산

/**
 * closes/highs/lows/volumes/dates: 종목 OHLCV (오래된 → 최신 순)
 * opens: 종목 시가 (진입가 계산용)
 * indexCloses: 기준 지수 종가 (같은 기간, 같은 길이) - 시장 국면 판별용
 * lookback: 신고가/돌파 판단 기준 기간(거래일). 미지정 시 CONFIG 기본값(36주) 사용
 *
 * ⚠️ RS Rating(스캔 종목군 내 백분위)은 백테스트가 단일 종목만 보기 때문에
 * 계산 대상 종목군이 없어서 여기서는 반영하지 않습니다 - 스크리너에만 있는 조건입니다.
 */
function runBreakoutBacktest({ dates, opens, highs, lows, closes, volumes, indexCloses, lookback }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const n = closes.length;
  // 트렌드템플릿(200일선+1개월) 계산에 필요한 기간까지 감안해 최소 lookback 결정
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
      const trendTemplateOk = trendOk === true; // null(데이터부족)이면 미통과 취급 - minLookback 덕에 이 시점엔 거의 안 나옴

      if (regimeOk && breakout.isBreakout && volumeOk && nearHighOk && trendTemplateOk) {
        // 다음날 시가에 진입한다고 가정
        entry = {
          entryIndex: i + 1,
          entryDate: dates[i + 1],
          entryPrice: opens[i + 1],
          stopLoss: breakout.stopLossLevel,
          stopLossBasis: breakout.stopLossBasis,
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
  // 거래비용(수수료+슬리피지 가정치, 편도) 반영: 매수는 더 비싸게, 매도는 더 싸게 체결된다고 가정
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
    grossReturnPct: round(grossReturnPct * 100, 2), // 거래비용 반영 전
    returnPct: round(returnPct * 100, 2),            // 거래비용 반영 후 (순수익률)
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

  // 매 거래마다 자본 전액을 순차 재투자한다고 가정한 복리 수익률(순수익 기준) + 최대낙폭(MDD)
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossEquity = 1; // 거래비용 반영 전 비교용
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
      grossCompoundedReturnPct: round((grossEquity - 1) * 100, 1), // 거래비용 반영 전 (참고용)
      tradingCostDragPct: round((grossEquity - equity) / grossEquity * 100, 1), // 거래비용으로 깎인 정도
      maxDrawdownPct: round(maxDrawdown * 100, 1),
      exitReasonCounts: trades.reduce((acc, t) => {
        acc[t.reason] = (acc[t.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = { runBreakoutBacktest };
