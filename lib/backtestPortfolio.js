// ============================================================
// [실험용 포트폴리오 백테스터] "상위 N개 압축" 검증용.
// 기존 백테스터들은 종목 하나씩 독립적으로 시뮬레이션했지만,
// 이건 여러 종목을 "동시에" 최대 N개까지만 담는 진짜 포트폴리오 시뮬레이션입니다.
// 같은 날 여러 종목이 신호를 내면, 지수 대비 60일 초과수익률(강도) 상위부터 채웁니다.
// 슬롯당 고정 비중(1/N)을 가정한 단순화 모델 - 실현 손익 시점에만 포트폴리오 자산에 반영
// (보유 중 미실현 변동은 자산곡선에 반영 안 됨 - MDD는 과소평가될 수 있음, 아래 보고에 명시)
//
// exitStrategy: 'ma20' (20일선 이탈시 매도) | 'trailing' (고점대비 -X% 트레일링)
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
const RS_LOOKBACK = 60;

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function round(v, digits = 2) { const m = Math.pow(10, digits); return Math.round(v * m) / m; }

function buildDateMap(dates) {
  const map = new Map();
  dates.forEach((d, idx) => map.set(d, idx));
  return map;
}

function runPortfolioBacktest({ universe, indexDates, indexCloses, maxPositions = 10, exitStrategy = 'ma20', trailStopPct = 0.15, lookback }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const trendTemplateNeed = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;

  // 종목별 날짜->로컬인덱스 맵 미리 구축 (마스터 루프는 지수 날짜 기준으로 돔)
  const stocks = universe.map(u => ({ ...u, dateMap: buildDateMap(u.dates) }));

  const held = new Map(); // ticker -> { entryLocalIndex, entryPrice, stopLoss, stopLossBasis, peakClose, entryDate, allocation }
  const trades = [];
  let equity = 1;
  let peakEquity = 1;
  let maxDrawdown = 0;
  const equitySeries = [];

  // 지수 자체 최소 lookback 필요 (국면 판별용 60일선)
  const idxMinLookback = CONFIG.maLong + 5;

  for (let mi = idxMinLookback; mi < indexDates.length; mi++) {
    const indexSlice = indexCloses.slice(0, mi + 1);
    const regime = classifyMarketRegime(indexSlice);
    const today = indexDates[mi];

    // 1) 기존 보유 종목 청산 판정 (오늘 데이터 있는 것만)
    for (const [ticker, pos] of [...held.entries()]) {
      const stock = stocks.find(s => s.ticker === ticker);
      const li = stock.dateMap.get(today);
      if (li === undefined || li >= stock.closes.length) continue; // 오늘 데이터 없음 - 건너뜀
      const holdDays = li - pos.entryLocalIndex;

      if (stock.opens[li] <= pos.stopLoss) {
        realize(pos, today, stock.opens[li], 'stop_loss_gap', holdDays);
        held.delete(ticker);
        continue;
      }
      if (stock.lows[li] <= pos.stopLoss) {
        realize(pos, today, pos.stopLoss, 'stop_loss', holdDays);
        held.delete(ticker);
        continue;
      }

      let exitSignal = false;
      if (exitStrategy === 'ma20') {
        const ma20 = sma(stock.closes.slice(0, li + 1), 20);
        exitSignal = ma20 !== null && stock.closes[li] < ma20;
      } else {
        pos.peakClose = Math.max(pos.peakClose, stock.closes[li]);
        exitSignal = stock.closes[li] <= pos.peakClose * (1 - trailStopPct);
      }
      if (exitSignal) {
        const nextLi = li + 1;
        if (nextLi < stock.closes.length) {
          realize(pos, stock.dates[nextLi], stock.opens[nextLi], exitStrategy === 'ma20' ? 'ma20_break' : 'trailing_stop', holdDays + 1);
          held.delete(ticker);
        }
        continue;
      }
      if (holdDays >= MAX_HOLD_DAYS) {
        realize(pos, today, stock.closes[li], 'max_hold', holdDays);
        held.delete(ticker);
      }
    }

    // 2) 오늘 신규 후보 스캔 (보유 중이 아닌 종목만)
    const openSlots = maxPositions - held.size;
    if (openSlots > 0) {
      const candidates = [];
      for (const stock of stocks) {
        if (held.has(stock.ticker)) continue;
        const li = stock.dateMap.get(today);
        if (li === undefined) continue;
        if (li < Math.max(effectiveLookback, trendTemplateNeed, RS_LOOKBACK) + 1) continue;
        if (li + 1 >= stock.closes.length) continue; // 익일 데이터 없으면 진입 불가

        const closesSlice = stock.closes.slice(0, li + 1);
        const highsSlice = stock.highs.slice(0, li + 1);
        const volumesSlice = stock.volumes.slice(0, li + 1);
        const lowsSlice = stock.lows.slice(0, li + 1);

        const breakout = checkBreakout(highsSlice, closesSlice, lowsSlice, effectiveLookback);
        if (!breakout.isBreakout) continue;
        const volRatio = volumeSurgeRatio(volumesSlice);
        if (volRatio === null || volRatio < CONFIG.volumeSurgeMultiple) continue;
        const highDistance = distanceFromFiftyTwoWeekHigh(highsSlice, closesSlice, effectiveLookback);
        if (highDistance === null || highDistance < CONFIG.nearHighThreshold) continue;
        if (checkTrendTemplate(closesSlice) !== true) continue;
        const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';
        if (!regimeOk) continue;

        // 지수 인덱스 li 대비 - 지수 쪽도 같은 날짜여야 하므로 인덱스 자체의 mi 기준 60일 수익률 사용
        const idxRet = indexCloses[mi] / indexCloses[mi - RS_LOOKBACK] - 1;
        const stockRet = stock.closes[li] / stock.closes[li - RS_LOOKBACK] - 1;
        const rsExcess = stockRet - idxRet;

        candidates.push({ stock, li, breakout, rsExcess });
      }
      candidates.sort((a, b) => b.rsExcess - a.rsExcess);
      for (const cand of candidates.slice(0, openSlots)) {
        const { stock, li, breakout } = cand;
        const entryLi = li + 1;
        held.set(stock.ticker, {
          ticker: stock.ticker,
          entryLocalIndex: entryLi,
          entryDate: stock.dates[entryLi],
          entryPrice: stock.opens[entryLi],
          stopLoss: breakout.stopLossLevel,
          stopLossBasis: breakout.stopLossBasis,
          peakClose: stock.opens[entryLi],
          allocation: 1 / maxPositions,
        });
      }
    }

    equitySeries.push({ date: today, equity, openPositions: held.size });
  }

  // 남은 보유 포지션은 "미청산(참고용)"으로 마지막 데이터로 정리 (에쿼티엔 반영 안 함 - 미실현)
  const stillOpen = held.size;

  function realize(pos, exitDate, exitPrice, reason, holdDays) {
    const cost = CONFIG.oneWayTradingCostPct;
    const effEntry = pos.entryPrice * (1 + cost);
    const effExit = exitPrice * (1 - cost);
    const returnPct = (effExit / effEntry - 1) * 100;
    equity *= 1 + pos.allocation * (returnPct / 100);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peakEquity) / peakEquity);
    trades.push({
      ticker: pos.ticker, entryDate: pos.entryDate, entryPrice: round(pos.entryPrice),
      exitDate, exitPrice: round(exitPrice), reason, holdDays, returnPct: round(returnPct, 2),
    });
  }

  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const profitFactor = losses.length
    ? Math.abs(wins.reduce((a, t) => a + t.returnPct, 0) / losses.reduce((a, t) => a + t.returnPct, 0)) : null;

  // 슬롯이 부족해서 밀려난 신호가 얼마나 있었는지(압축 효과 확인용)는 별도 카운트 안 함 - 필요시 추가 가능

  return {
    trades,
    stillOpenAtEnd: stillOpen,
    summary: {
      totalTrades: trades.length,
      winRate: round(winRate, 1),
      avgWinPct: round(avgWin, 2),
      avgLossPct: round(avgLoss, 2),
      profitFactor: profitFactor !== null ? round(profitFactor, 2) : null,
      portfolioReturnPct: round((equity - 1) * 100, 1),
      portfolioMaxDrawdownPct: round(maxDrawdown * 100, 1),
      exitReasonCounts: trades.reduce((acc, t) => { acc[t.reason] = (acc[t.reason] || 0) + 1; return acc; }, {}),
    },
  };
}

module.exports = { runPortfolioBacktest };
