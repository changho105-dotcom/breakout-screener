// ============================================================
// [실험용 포트폴리오 v2] 선별 로직(체크리스트) 자체를 검증하기 위한 버전.
// v1(backtestPortfolio.js) 대비 추가된 것:
//  - RS Rating을 진짜로 계산 (오늘 스캔 대상 종목군 내 60일 수익률 백분위) - 스크리너와 동일 조건
//  - 유동성 하드필터 추가 (20일 평균거래대금)
//  - requiredChecks로 5개 보조조건(regime/nearHigh/volume/trend/rs) 중 어떤 걸
//    필수로 요구할지 토글 가능 -> 제거검증(ablation)에 사용
//  - 매 후보에 score(0~5, 5개 보조조건 중 실제 통과 개수)를 태깅 -> 점수-성과 상관관계 분석용
// 돌파(breakoutOk) 자체는 항상 필수 - 이게 없으면 "돌파매매"라는 정체성 자체가 없어짐
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
const RS_RATING_THRESHOLD = 70; // 스크리너와 동일 (백분위 70 이상)

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

function passesLiquidity(closes, volumes, market) {
  if (closes.length < 20 || volumes.length < 20) return false;
  const c = closes.slice(-20), v = volumes.slice(-20);
  const avgValue = c.reduce((a, cv, i) => a + cv * v[i], 0) / 20;
  const threshold = market === 'KR' ? CONFIG.minTradingValueKR : CONFIG.minTradingValueUS;
  return avgValue >= threshold;
}

/**
 * requiredChecks: 배열, 부분집합 of ['regime','nearHigh','volume','trend','rs']
 *   - 여기 포함된 조건만 "필수"로 요구(AND). 나머지는 score 계산에는 들어가지만 진입 게이트는 아님.
 *   - 기본값(전부 포함)이면 지금 프로덕션 체크리스트와 동일.
 * minFromSet: { set: [...조건이름], min: N } (선택) - requiredChecks와 별개로,
 *   "이 집합 중 최소 N개는 통과해야 함"(OR형 게이트) 조건을 추가로 걸 때 사용.
 *   트렌드템플릿은 hardRequired로 항상 걸고, 나머지는 minFromSet으로 "몇 개 이상"만 요구하는 식의
 *   가중치 재설계안 테스트용.
 */
function runPortfolioV2Backtest({ universe, indexDates, indexCloses, market = 'US', maxPositions = 10,
  requiredChecks = ['regime', 'nearHigh', 'volume', 'trend', 'rs'], minFromSet = null, lookback, exitStrategy = 'ma20', trailStopPct = 0.15,
  tradeStartDate = null, initialCapital = 1 }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const trendTemplateNeed = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;
  const need = (name) => requiredChecks.includes(name);

  const stocks = universe.map(u => ({ ...u, dateMap: buildDateMap(u.dates) }));
  const held = new Map();
  const trades = [];
  let equity = initialCapital, peakEquity = initialCapital, maxDrawdown = 0;
  const idxMinLookback = CONFIG.maLong + 5;

  function realize(pos, exitDate, exitPrice, reason, holdDays) {
    const cost = CONFIG.oneWayTradingCostPct;
    const effEntry = pos.entryPrice * (1 + cost);
    const effExit = exitPrice * (1 - cost);
    const returnPct = (effExit / effEntry - 1) * 100;
    const entryAmount = pos.entryEquity * pos.allocation;
    const exitAmount = entryAmount * (1 + returnPct / 100);
    equity += (exitAmount - entryAmount);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peakEquity) / peakEquity);
    trades.push({
      ticker: pos.ticker, entryDate: pos.entryDate, exitDate, reason, holdDays,
      returnPct: round(returnPct, 2), entryScore: pos.entryScore,
      entryPrice: round(pos.entryPrice, 2), exitPrice: round(exitPrice, 2),
      shares: pos.shares, entryAmount: round(entryAmount, 0), exitAmount: round(exitAmount, 0),
      pnlAmount: round(exitAmount - entryAmount, 0),
    });
  }

  for (let mi = idxMinLookback; mi < indexDates.length; mi++) {
    const indexSlice = indexCloses.slice(0, mi + 1);
    const regime = classifyMarketRegime(indexSlice);
    const today = indexDates[mi];
    const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';

    // 1) 청산 처리
    for (const [ticker, pos] of [...held.entries()]) {
      const stock = stocks.find(s => s.ticker === ticker);
      const li = stock.dateMap.get(today);
      if (li === undefined || li >= stock.closes.length) continue;
      // 거래정지/오류로 0 이하 가격이 찍히는 날은 실현 처리 없이 건너뜀(다음 정상 데이터까지 보유 유지)
      if (!(stock.opens[li] > 0) || !(stock.closes[li] > 0) || !(stock.lows[li] > 0)) continue;
      const holdDays = li - pos.entryLocalIndex;

      if (stock.opens[li] <= pos.stopLoss) { realize(pos, today, stock.opens[li], 'stop_loss_gap', holdDays); held.delete(ticker); continue; }
      if (stock.lows[li] <= pos.stopLoss) { realize(pos, today, pos.stopLoss, 'stop_loss', holdDays); held.delete(ticker); continue; }

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
      if (holdDays >= MAX_HOLD_DAYS) { realize(pos, today, stock.closes[li], 'max_hold', holdDays); held.delete(ticker); }
    }

    // tradeStartDate 이전에는 신규 매수를 하지 않음(청산 로직은 위에서 이미 처리됨) - 특정 시점부터
    // "지금 이 방식으로 막 시작했다"를 시뮬레이션할 때 사용
    if (tradeStartDate && today < tradeStartDate) continue;

    // 2) RS Rating용 - 오늘 데이터 있는 전 종목의 60일 수익률 분포 먼저 계산
    const openSlots = maxPositions - held.size;
    if (openSlots <= 0) continue;

    const returnsToday = [];
    const liByTicker = new Map();
    for (const stock of stocks) {
      const li = stock.dateMap.get(today);
      if (li === undefined) continue;
      liByTicker.set(stock.ticker, li);
      if (li >= RS_LOOKBACK) {
        const ret = stock.closes[li] / stock.closes[li - RS_LOOKBACK] - 1;
        returnsToday.push({ ticker: stock.ticker, ret });
      }
    }
    returnsToday.sort((a, b) => a.ret - b.ret);
    const nRs = returnsToday.length;
    const rsPercentile = new Map();
    returnsToday.forEach((item, idx) => rsPercentile.set(item.ticker, nRs > 1 ? (idx / (nRs - 1)) * 100 : 50));

    // 3) 후보 스캔
    const candidates = [];
    for (const stock of stocks) {
      if (held.has(stock.ticker)) continue;
      const li = liByTicker.get(stock.ticker);
      if (li === undefined) continue;
      if (li < Math.max(effectiveLookback, trendTemplateNeed, RS_LOOKBACK) + 1) continue;
      if (li + 1 >= stock.closes.length) continue;
      // 데이터 이상치 방어: 거래정지/오류로 시가·종가가 0 이하로 찍히는 날이 실제로 있음
      // (예: KOSDAQ 086520 등) - 그대로 두면 0으로 나눠서 NaN이 전체 자산곡선에 전파됨
      if (!(stock.opens[li + 1] > 0) || !(stock.closes[li] > 0) || !(stock.opens[li] > 0)) continue;

      const closesSlice = stock.closes.slice(0, li + 1);
      const highsSlice = stock.highs.slice(0, li + 1);
      const volumesSlice = stock.volumes.slice(0, li + 1);
      const lowsSlice = stock.lows.slice(0, li + 1);

      if (!passesLiquidity(closesSlice, volumesSlice, market)) continue;

      const breakout = checkBreakout(highsSlice, closesSlice, lowsSlice, effectiveLookback);
      if (!breakout.isBreakout) continue; // 돌파 자체는 항상 필수

      const volRatio = volumeSurgeRatio(volumesSlice);
      const volumeOk = volRatio !== null && volRatio >= CONFIG.volumeSurgeMultiple;
      const highDistance = distanceFromFiftyTwoWeekHigh(highsSlice, closesSlice, effectiveLookback);
      const nearHighOk = highDistance !== null && highDistance >= CONFIG.nearHighThreshold;
      const trendOk = checkTrendTemplate(closesSlice) === true;
      const rsPct = rsPercentile.get(stock.ticker) ?? null;
      const rsOk = rsPct !== null && rsPct >= RS_RATING_THRESHOLD;

      const checks = { regime: regimeOk, nearHigh: nearHighOk, volume: volumeOk, trend: trendOk, rs: rsOk };
      const score = Object.values(checks).filter(Boolean).length;

      // requiredChecks에 포함된 것들은 전부 통과해야 후보 인정
      const passesRequired = requiredChecks.every(name => checks[name]);
      if (!passesRequired) continue;
      // minFromSet: 지정된 집합 중 최소 N개는 통과해야 함 (OR형 추가 게이트)
      if (minFromSet) {
        const passCountInSet = minFromSet.set.filter(name => checks[name]).length;
        if (passCountInSet < minFromSet.min) continue;
      }

      const idxRet = indexCloses[mi] / indexCloses[mi - RS_LOOKBACK] - 1;
      const stockRet = stock.closes[li] / stock.closes[li - RS_LOOKBACK] - 1;
      const rsExcess = stockRet - idxRet;

      candidates.push({ stock, li, breakout, rsExcess, score });
    }
    candidates.sort((a, b) => b.rsExcess - a.rsExcess);
    for (const cand of candidates.slice(0, openSlots)) {
      const { stock, li, breakout, score } = cand;
      const entryLi = li + 1;
      const entryPrice = stock.opens[entryLi];
      const allocation = 1 / maxPositions;
      const entryAmount = equity * allocation;
      held.set(stock.ticker, {
        ticker: stock.ticker, entryLocalIndex: entryLi, entryDate: stock.dates[entryLi],
        entryPrice, stopLoss: breakout.stopLossLevel,
        peakClose: entryPrice, allocation, entryScore: score,
        entryEquity: equity, shares: Math.floor(entryAmount / entryPrice),
      });
    }
  }

  // 시뮬레이션 종료 시점까지 보유 중인 포지션 - 마지막 가격으로 미실현 평가
  const openPositions = [];
  for (const [ticker, pos] of held.entries()) {
    const stock = stocks.find(s => s.ticker === ticker);
    const lastIdx = stock.closes.length - 1;
    const lastPrice = stock.closes[lastIdx];
    const entryAmount = pos.entryEquity * pos.allocation;
    const unrealizedAmount = entryAmount * (lastPrice / pos.entryPrice);
    openPositions.push({
      ticker, entryDate: pos.entryDate, entryPrice: round(pos.entryPrice, 2),
      lastDate: stock.dates[lastIdx], lastPrice: round(lastPrice, 2), shares: pos.shares,
      entryAmount: round(entryAmount, 0), currentAmount: round(unrealizedAmount, 0),
      unrealizedPnl: round(unrealizedAmount - entryAmount, 0),
      unrealizedReturnPct: round((lastPrice / pos.entryPrice - 1) * 100, 2),
      stopLoss: round(pos.stopLoss, 2),
    });
  }
  // 미실현 손익까지 반영한 평가자산(에쿼티는 실현손익만 반영돼있으므로 별도 합산)
  const unrealizedTotal = openPositions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const markToMarketEquity = equity + unrealizedTotal;

  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = losses.length
    ? Math.abs(wins.reduce((a, t) => a + t.returnPct, 0) / losses.reduce((a, t) => a + t.returnPct, 0)) : null;

  return {
    trades,
    openPositions,
    summary: {
      totalTrades: trades.length, winRate: round(winRate, 1),
      profitFactor: profitFactor !== null ? round(profitFactor, 2) : null,
      initialCapital: round(initialCapital, 0),
      realizedEquity: round(equity, 0),
      markToMarketEquity: round(markToMarketEquity, 0),
      portfolioReturnPct: round((equity - initialCapital) / initialCapital * 100, 1),
      markToMarketReturnPct: round((markToMarketEquity - initialCapital) / initialCapital * 100, 1),
      portfolioMaxDrawdownPct: round(maxDrawdown * 100, 1),
    },
  };
}

module.exports = { runPortfolioV2Backtest };
