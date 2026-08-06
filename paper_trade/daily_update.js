// ============================================================
// 실전 가상매매(paper trading) 일일 업데이트 스크립트
// - 한화 포트폴리오: 코스피+코스닥 통합, 5천만원, 최대 10슬롯
// - 달러 포트폴리오: 미국(S&P500+다우30+나스닥100), 5천만원 상당 달러, 최대 10슬롯
// - 매일 실행: 1) 기존 보유 종목 20일선 이탈/손절 체크 → 매도
//              2) 빈 슬롯 있으면 오늘 조건(국면+거래량+트렌드템플릿+RS) 통과 종목 중
//                 지수 대비 60일 초과수익 상위부터 채움 (익일 시가 체결 가정)
// - 상태는 paper_trade/state.json 에 저장, 로그는 paper_trade/log.md 에 누적
// ============================================================

const fs = require('fs');
const path = require('path');
const krSource = require('../lib/krSource');
const usSource = require('../lib/usSource');
const {
  classifyMarketRegime, checkBreakout, volumeSurgeRatio,
  checkTrendTemplate, computeRsRatings, CONFIG,
} = require('../lib/indicators');

const STATE_PATH = path.join(__dirname, 'state.json');
const LOG_PATH = path.join(__dirname, 'log.md');
const RS_LOOKBACK = 60;
const RS_THRESHOLD = 70;
const MAX_SLOTS = 10;
const KRW_CAPITAL = 50_000_000;
const USD_CAPITAL_KRW_EQUIV = 50_000_000;

function today() { return new Date().toISOString().slice(0, 10); }

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return {
    startDate: today(),
    dayCount: 0,
    kr: { cash: KRW_CAPITAL, positions: [], realizedPnl: 0, trades: [] },
    us: { cashKrwEquiv: USD_CAPITAL_KRW_EQUIV, cashUsd: null, positions: [], realizedPnl: 0, trades: [], fxRateAtStart: null },
  };
}

function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

function appendLog(text) { fs.appendFileSync(LOG_PATH, text + '\n'); }

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchFx() {
  const fetch = require('node-fetch');
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=5d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await res.json();
  const closes = j.chart.result[0].indicators.quote[0].close.filter(c => c != null);
  return closes[closes.length - 1];
}

// ---- 코스피+코스닥 통합 스캔 ----
async function scanKR() {
  const [kospiList, kosdaqList] = await Promise.all([krSource.fetchStockList(0, 4), krSource.fetchStockList(1, 4)]);
  const [kospiIdx, kosdaqIdx] = await Promise.all([krSource.fetchIndexOHLCV('KOSPI', 300), krSource.fetchIndexOHLCV('KOSDAQ', 300)]);
  const regimeByMarket = {
    KOSPI: classifyMarketRegime(kospiIdx.closes),
    KOSDAQ: classifyMarketRegime(kosdaqIdx.closes),
  };
  const idxCloses = { KOSPI: kospiIdx.closes, KOSDAQ: kosdaqIdx.closes };

  const { runBatched } = require('../lib/batch');
  const stockList = [...kospiList, ...kosdaqList];
  const withOhlcv = await runBatched(stockList, async (s) => {
    const o = await krSource.fetchOHLCV(s.ticker, 300);
    if (!o.closes.length) return null;
    return { ...s, ohlcv: o };
  }, 8);

  const rsRatings = computeRsRatings(withOhlcv.map(s => ({ key: s.ticker, closes: s.ohlcv.closes })), RS_LOOKBACK);

  const candidates = [];
  for (const s of withOhlcv) {
    const { ohlcv, market } = s;
    const regimeOk = regimeByMarket[market] === 'STRONG_UP' || regimeByMarket[market] === 'WEAK_UP';
    if (!regimeOk) continue;
    const breakout = checkBreakout(ohlcv.highs, ohlcv.closes, ohlcv.lows, CONFIG.breakoutLookback);
    if (!breakout.isBreakout) continue;
    const volRatio = volumeSurgeRatio(ohlcv.volumes);
    if (volRatio === null || volRatio < CONFIG.volumeSurgeMultiple) continue;
    if (checkTrendTemplate(ohlcv.closes) !== true) continue;
    const rsPct = rsRatings[s.ticker];
    if (rsPct === undefined || rsPct < RS_THRESHOLD) continue;
    if (ohlcv.closes.length < RS_LOOKBACK + 1) continue;
    const idxC = idxCloses[market];
    const idxRet = idxC[idxC.length - 1] / idxC[idxC.length - 1 - RS_LOOKBACK] - 1;
    const stockRet = ohlcv.closes[ohlcv.closes.length - 1] / ohlcv.closes[ohlcv.closes.length - 1 - RS_LOOKBACK] - 1;
    candidates.push({
      ticker: s.ticker, name: s.name, market, rsExcess: stockRet - idxRet,
      lastClose: ohlcv.closes[ohlcv.closes.length - 1], stopLoss: breakout.stopLossLevel,
    });
  }
  candidates.sort((a, b) => b.rsExcess - a.rsExcess);
  return { candidates, regimeByMarket };
}

// ---- 미국 스캔 ----
async function scanUS() {
  const stockList = await usSource.fetchStockList();
  const idx = await usSource.fetchIndexOHLCV(300);
  const regime = classifyMarketRegime(idx.closes);
  const regimeOk = regime === 'STRONG_UP' || regime === 'WEAK_UP';

  const { runBatched } = require('../lib/batch');
  const withOhlcv = await runBatched(stockList, async (s) => {
    const o = await usSource.fetchOHLCV(s.ticker, 300);
    if (!o.closes.length) return null;
    return { ...s, ohlcv: o };
  }, 10);

  const rsRatings = computeRsRatings(withOhlcv.map(s => ({ key: s.ticker, closes: s.ohlcv.closes })), RS_LOOKBACK);

  const candidates = [];
  if (regimeOk) {
    for (const s of withOhlcv) {
      const { ohlcv } = s;
      const breakout = checkBreakout(ohlcv.highs, ohlcv.closes, ohlcv.lows, CONFIG.breakoutLookback);
      if (!breakout.isBreakout) continue;
      const volRatio = volumeSurgeRatio(ohlcv.volumes);
      if (volRatio === null || volRatio < CONFIG.volumeSurgeMultiple) continue;
      if (checkTrendTemplate(ohlcv.closes) !== true) continue;
      const rsPct = rsRatings[s.ticker];
      if (rsPct === undefined || rsPct < RS_THRESHOLD) continue;
      if (ohlcv.closes.length < RS_LOOKBACK + 1) continue;
      const idxRet = idx.closes[idx.closes.length - 1] / idx.closes[idx.closes.length - 1 - RS_LOOKBACK] - 1;
      const stockRet = ohlcv.closes[ohlcv.closes.length - 1] / ohlcv.closes[ohlcv.closes.length - 1 - RS_LOOKBACK] - 1;
      candidates.push({
        ticker: s.ticker, name: s.name, rsExcess: stockRet - idxRet,
        lastClose: ohlcv.closes[ohlcv.closes.length - 1], stopLoss: breakout.stopLossLevel,
      });
    }
  }
  candidates.sort((a, b) => b.rsExcess - a.rsExcess);
  return { candidates, regime };
}

async function checkExitsKR(portfolio) {
  const exits = [];
  const stillHeld = [];
  for (const pos of portfolio.positions) {
    const o = await krSource.fetchOHLCV(pos.ticker, 60);
    if (!o.closes.length) { stillHeld.push(pos); continue; }
    const lastClose = o.closes[o.closes.length - 1];
    const lastLow = o.lows[o.lows.length - 1];
    const ma20 = sma(o.closes, 20);
    let exitReason = null, exitPrice = null;
    if (lastLow <= pos.stopLoss) { exitReason = 'stop_loss'; exitPrice = pos.stopLoss; }
    else if (ma20 !== null && lastClose < ma20) { exitReason = 'ma20_break'; exitPrice = o.opens[o.opens.length - 1]; }
    if (exitReason) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      exits.push({ ...pos, exitDate: today(), exitPrice, exitReason, pnl });
      portfolio.cash += exitPrice * pos.shares;
      portfolio.realizedPnl += pnl;
    } else stillHeld.push(pos);
  }
  portfolio.positions = stillHeld;
  return exits;
}

async function main() {
  const state = loadState();
  state.dayCount++;
  const d = today();
  appendLog(`\n## ${d} (Day ${state.dayCount})\n`);

  if (state.us.fxRateAtStart === null) {
    const fx = await fetchFx();
    state.us.fxRateAtStart = fx;
    state.us.cashUsd = USD_CAPITAL_KRW_EQUIV / fx;
    appendLog(`- 시작 환율: 1 USD = ${fx.toFixed(2)} KRW, 달러 포트폴리오 시작자본: $${state.us.cashUsd.toFixed(2)}`);
  }

  // ---- KR ----
  const krExits = await checkExitsKR(state.kr);
  for (const e of krExits) {
    appendLog(`- [KR 매도] ${e.ticker} ${e.name || ''} - ${e.exitReason} @ ${e.exitPrice} (진입 ${e.entryPrice}) 손익 ${Math.round(e.pnl).toLocaleString()}원`);
    state.kr.trades.push(e);
  }
  const krOpenSlots = MAX_SLOTS - state.kr.positions.length;
  if (krOpenSlots > 0) {
    const { candidates } = await scanKR();
    const held = new Set(state.kr.positions.map(p => p.ticker));
    const picks = candidates.filter(c => !held.has(c.ticker)).slice(0, krOpenSlots);
    const allocPerSlot = KRW_CAPITAL / MAX_SLOTS;
    for (const p of picks) {
      const shares = Math.floor(Math.min(allocPerSlot, state.kr.cash) / p.lastClose);
      if (shares <= 0) continue;
      const cost = shares * p.lastClose;
      state.kr.cash -= cost;
      state.kr.positions.push({ ticker: p.ticker, name: p.name, market: p.market, entryDate: d, entryPrice: p.lastClose, shares, stopLoss: p.stopLoss });
      appendLog(`- [KR 매수] ${p.ticker} ${p.name || ''} (${p.market}) @ ${p.lastClose} x ${shares}주 = ${Math.round(cost).toLocaleString()}원 (RS초과수익 ${(p.rsExcess * 100).toFixed(1)}%)`);
    }
    if (picks.length === 0) appendLog(`- [KR] 빈 슬롯 ${krOpenSlots}개, 조건 통과 신규 후보 없음`);
  } else {
    appendLog(`- [KR] 10슬롯 전부 보유 중, 신규 스캔 생략`);
  }

  // ---- US ----
  const usExits = [];
  const stillHeldUs = [];
  for (const pos of state.us.positions) {
    const o = await usSource.fetchOHLCV(pos.ticker, 60);
    if (!o.closes.length) { stillHeldUs.push(pos); continue; }
    const lastClose = o.closes[o.closes.length - 1];
    const lastLow = o.lows[o.lows.length - 1];
    const ma20 = sma(o.closes, 20);
    let exitReason = null, exitPrice = null;
    if (lastLow <= pos.stopLoss) { exitReason = 'stop_loss'; exitPrice = pos.stopLoss; }
    else if (ma20 !== null && lastClose < ma20) { exitReason = 'ma20_break'; exitPrice = o.opens[o.opens.length - 1]; }
    if (exitReason) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      usExits.push({ ...pos, exitDate: d, exitPrice, exitReason, pnl });
      state.us.cashUsd += exitPrice * pos.shares;
      state.us.realizedPnl += pnl;
    } else stillHeldUs.push(pos);
  }
  state.us.positions = stillHeldUs;
  for (const e of usExits) {
    appendLog(`- [US 매도] ${e.ticker} - ${e.exitReason} @ $${e.exitPrice} (진입 $${e.entryPrice}) 손익 $${e.pnl.toFixed(2)}`);
    state.us.trades.push(e);
  }
  const usOpenSlots = MAX_SLOTS - state.us.positions.length;
  if (usOpenSlots > 0) {
    const { candidates } = await scanUS();
    const held = new Set(state.us.positions.map(p => p.ticker));
    const picks = candidates.filter(c => !held.has(c.ticker)).slice(0, usOpenSlots);
    const allocPerSlot = state.us.cashUsd > 0 ? (USD_CAPITAL_KRW_EQUIV / state.us.fxRateAtStart) / MAX_SLOTS : 0;
    for (const p of picks) {
      const shares = Math.floor(Math.min(allocPerSlot, state.us.cashUsd) / p.lastClose);
      if (shares <= 0) continue;
      const cost = shares * p.lastClose;
      state.us.cashUsd -= cost;
      state.us.positions.push({ ticker: p.ticker, name: p.name, entryDate: d, entryPrice: p.lastClose, shares, stopLoss: p.stopLoss });
      appendLog(`- [US 매수] ${p.ticker} ${p.name || ''} @ $${p.lastClose} x ${shares}주 = $${cost.toFixed(2)} (RS초과수익 ${(p.rsExcess * 100).toFixed(1)}%)`);
    }
    if (picks.length === 0) appendLog(`- [US] 빈 슬롯 ${usOpenSlots}개, 조건 통과 신규 후보 없음`);
  } else {
    appendLog(`- [US] 10슬롯 전부 보유 중, 신규 스캔 생략`);
  }

  saveState(state);
  appendLog(`- KR 현금: ${Math.round(state.kr.cash).toLocaleString()}원, 보유 ${state.kr.positions.length}종목 / US 현금: $${state.us.cashUsd.toFixed(2)}, 보유 ${state.us.positions.length}종목`);
  console.log('done, day', state.dayCount);
}

main().catch(e => { appendLog(`- ERROR: ${e.message}`); console.error(e); process.exit(1); });
