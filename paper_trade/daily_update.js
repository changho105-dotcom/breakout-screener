// ============================================================
// 실전 가상매매(paper trading) 일일 업데이트 스크립트
// - 한화 포트폴리오: 코스피+코스닥 통합, 5천만원, 최대 10슬롯
// - 달러 포트폴리오: 미국(S&P500+다우30+나스닥100), 5천만원 상당 달러, 최대 10슬롯
// - 매일 실행: 1) 기존 보유 종목 20일선 이탈/손절 체크 → 매도
//              2) 빈 슬롯 있으면 오늘 조건(국면+거래량+트렌드템플릿+RS) 통과 종목 중
//                 지수 대비 60일 초과수익 상위부터 채움 (익일 시가 체결 가정)
// - 상태는 paper_trade/state.json 에 저장, 로그는 paper_trade/log.md 에 누적
//
// ⚠️ 에러 격리 원칙 (2026-08-17 사고 이후 적용):
// 종목 하나·시장 하나의 데이터 조회가 실패해도 전체 스크립트가 죽지 않도록,
// (a) 보유종목 청산체크는 종목별로 개별 try/catch, (b) KR/US 시장 전체 처리도
// 서로 독립적으로 try/catch, (c) saveState()는 부분 실패가 있어도 항상 마지막에
// 실행되도록 만듦. 8/7~8/16 열흘간 CRL 하나의 Yahoo Finance 403 에러가 스크립트
// 전체를 죽여서 US 포트폴리오가 통째로 멈춰있었던 사고의 재발 방지.
// ============================================================

const fs = require('fs');
const path = require('path');
const krSource = require('../lib/krSource');
const usSource = require('../lib/usSource');
const {
  classifyMarketRegime, checkBreakout, volumeSurgeRatio,
  checkTrendTemplate, computeRsRatings, CONFIG,
} = require('../lib/indicators');
const { runBatched } = require('../lib/batch');

const STATE_PATH = path.join(__dirname, 'state.json');
const LOG_PATH = path.join(__dirname, 'log.md');
const RS_LOOKBACK = 60;
const RS_THRESHOLD = 70;
const MAX_SLOTS = 10;
const KRW_CAPITAL = 50_000_000;
const USD_CAPITAL_KRW_EQUIV = 50_000_000;

function today() { return new Date().toISOString().slice(0, 10); }

// 날짜 문자열(YYYY-MM-DD)을 UTC 자정으로 고정 파싱해서 실행 서버의 로컬 타임존과
// 무관하게 항상 같은 요일 판정이 나오게 함 (로컬 PC/Railway 등 실행 환경이 달라도 안전).
function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=일, 6=토
  return day === 0 || day === 6;
}

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
  if (!res.ok) {
    const bodyPreview = (await res.text()).slice(0, 200);
    throw new Error(`환율 조회 응답 오류: 상태코드 ${res.status} - ${bodyPreview}`);
  }
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`환율 조회 데이터 없음: ${j?.chart?.error?.description || '알 수 없는 오류'}`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
  if (!closes.length) throw new Error('환율 조회 결과에 유효한 종가가 없음');
  return closes[closes.length - 1];
}

// 종목 배치 조회 중 실패율이 이 이상이면(=상당수 종목이 데이터를 못 가져온 상태) 결과를
// "오늘은 조건 통과 종목이 없음"으로 보고하지 않고 에러로 처리 - 부분 실패가 "신호 없음"
// 으로 둔갑해서 사용자를 속이는 걸 막기 위함 (2026-08-29 리뷰에서 추가).
const MAX_FAILURE_RATE = 0.2;

/**
 * runBatched를 감싸서 실패율을 집계 -> 너무 높으면 던짐. scanKR/scanUS 공용.
 */
async function runBatchedChecked(items, worker, concurrency, label) {
  let failCount = 0;
  const results = await runBatched(items, worker, concurrency, () => { failCount++; });
  const total = items.length;
  const rate = total > 0 ? failCount / total : 0;
  if (rate > MAX_FAILURE_RATE) {
    throw new Error(`${label} 데이터 조회 실패율이 너무 높음 (${failCount}/${total} = ${(rate * 100).toFixed(0)}%) - 결과 신뢰 불가, 이번 회차 스킵`);
  }
  return { results, total, failCount };
}

// 200개 페이지씩 4장(코스피+코스닥 각 최대 200개)을 정상 크롤링하면 원래 수백 개가
// 나와야 함. res.ok는 정상(200)인데 페이지 구조가 바뀌어 셀렉터가 하나도 안 걸리면
// "정상 응답인데 0개"로 조용히 통과해버릴 수 있어서, 실패율 체크와 별개로 최소 개수
// 자체도 확인함 (2026-08-29 리뷰에서 추가 - MAX_FAILURE_RATE는 total이 0이면 못 잡음).
const MIN_UNIVERSE_KR = 100;
const MIN_UNIVERSE_US = 100;

// ---- 코스피+코스닥 통합 스캔 ----
async function scanKR() {
  const [kospiList, kosdaqList] = await Promise.all([krSource.fetchStockList(0, 4), krSource.fetchStockList(1, 4)]);
  const [kospiIdx, kosdaqIdx] = await Promise.all([krSource.fetchIndexOHLCV('KOSPI', 300), krSource.fetchIndexOHLCV('KOSDAQ', 300)]);
  const regimeByMarket = {
    KOSPI: classifyMarketRegime(kospiIdx.closes),
    KOSDAQ: classifyMarketRegime(kosdaqIdx.closes),
  };
  const idxCloses = { KOSPI: kospiIdx.closes, KOSDAQ: kosdaqIdx.closes };

  const stockList = [...kospiList, ...kosdaqList];
  if (stockList.length < MIN_UNIVERSE_KR) {
    throw new Error(`KR 종목리스트가 비정상적으로 적음 (${stockList.length}개, 최소 ${MIN_UNIVERSE_KR}개 기대) - 페이지 구조 변경 등 의심, 결과 신뢰 불가`);
  }
  const { results: withOhlcv, total: krTotal, failCount: krFailCount } = await runBatchedChecked(stockList, async (s) => {
    const o = await krSource.fetchOHLCV(s.ticker, 300);
    if (!o.closes.length) return null;
    return { ...s, ohlcv: o };
  }, 8, 'KR 종목');

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
  return { candidates, total: krTotal, failCount: krFailCount };
}

// ---- 미국 스캔 ----
// 2026-08-06 검증 결과: 미국은 시장국면 조건을 요구하지 않는 쪽이 일관되게 나았음 (README 참고)
async function scanUS() {
  const stockList = await usSource.fetchStockList();
  if (stockList.length < MIN_UNIVERSE_US) {
    throw new Error(`US 종목리스트가 비정상적으로 적음 (${stockList.length}개, 최소 ${MIN_UNIVERSE_US}개 기대) - CSV 소스 구조 변경 등 의심, 결과 신뢰 불가`);
  }
  const idx = await usSource.fetchIndexOHLCV(300);

  const { results: withOhlcv, total: usTotal, failCount: usFailCount } = await runBatchedChecked(stockList, async (s) => {
    const o = await usSource.fetchOHLCV(s.ticker, 300);
    if (!o.closes.length) return null;
    return { ...s, ohlcv: o };
  }, 10, 'US 종목');

  const rsRatings = computeRsRatings(withOhlcv.map(s => ({ key: s.ticker, closes: s.ohlcv.closes })), RS_LOOKBACK);

  const candidates = [];
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
  candidates.sort((a, b) => b.rsExcess - a.rsExcess);
  return { candidates, total: usTotal, failCount: usFailCount };
}

/**
 * KR 보유종목 청산 체크. 종목 하나의 데이터 조회가 실패해도 그 종목만 보유 유지로
 * 넘어가고 나머지는 계속 처리됨(개별 try/catch로 격리).
 */
async function checkExitsKR(portfolio, dateForLog) {
  const exits = [];
  const stillHeld = [];
  const warnings = [];
  for (const pos of portfolio.positions) {
    let o;
    try {
      o = await krSource.fetchOHLCV(pos.ticker, 60);
    } catch (err) {
      warnings.push(`- [KR 경고] ${pos.ticker} 가격 조회 실패, 보유 유지: ${err.message}`);
      stillHeld.push(pos);
      continue;
    }
    if (!o.closes.length) {
      warnings.push(`- [KR 경고] ${pos.ticker} 가격 데이터 없음(빈 응답), 보유 유지`);
      stillHeld.push(pos);
      continue;
    }
    const lastClose = o.closes[o.closes.length - 1];
    const lastLow = o.lows[o.lows.length - 1];
    const ma20 = sma(o.closes, 20);
    let exitReason = null, exitPrice = null;
    if (lastLow <= pos.stopLoss) { exitReason = 'stop_loss'; exitPrice = pos.stopLoss; }
    else if (ma20 !== null && lastClose < ma20) { exitReason = 'ma20_break'; exitPrice = o.opens[o.opens.length - 1]; }
    if (exitReason) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      exits.push({ ...pos, exitDate: dateForLog, exitPrice, exitReason, pnl });
      portfolio.cash += exitPrice * pos.shares;
      portfolio.realizedPnl += pnl;
    } else stillHeld.push(pos);
  }
  portfolio.positions = stillHeld;
  return { exits, warnings };
}

/**
 * US 보유종목 청산 체크. KR과 동일한 개별 try/catch 격리 적용.
 */
async function checkExitsUS(portfolio, dateForLog) {
  const exits = [];
  const stillHeld = [];
  const warnings = [];
  for (const pos of portfolio.positions) {
    let o;
    try {
      o = await usSource.fetchOHLCV(pos.ticker, 60);
    } catch (err) {
      warnings.push(`- [US 경고] ${pos.ticker} 가격 조회 실패, 보유 유지: ${err.message}`);
      stillHeld.push(pos);
      continue;
    }
    if (!o.closes.length) {
      warnings.push(`- [US 경고] ${pos.ticker} 가격 데이터 없음(빈 응답), 보유 유지`);
      stillHeld.push(pos);
      continue;
    }
    const lastClose = o.closes[o.closes.length - 1];
    const lastLow = o.lows[o.lows.length - 1];
    const ma20 = sma(o.closes, 20);
    let exitReason = null, exitPrice = null;
    if (lastLow <= pos.stopLoss) { exitReason = 'stop_loss'; exitPrice = pos.stopLoss; }
    else if (ma20 !== null && lastClose < ma20) { exitReason = 'ma20_break'; exitPrice = o.opens[o.opens.length - 1]; }
    if (exitReason) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      exits.push({ ...pos, exitDate: dateForLog, exitPrice, exitReason, pnl });
      portfolio.cashUsd += exitPrice * pos.shares;
      portfolio.realizedPnl += pnl;
    } else stillHeld.push(pos);
  }
  portfolio.positions = stillHeld;
  return { exits, warnings };
}

/**
 * KR 시장 전체 처리(청산체크 + 신규진입). 이 함수 자체가 통째로 실패해도(예: 네이버
 * 전체 장애) main()의 try/catch가 잡아서 US 처리는 계속 진행되도록 분리돼 있음.
 */
async function processKR(state, d) {
  const { exits, warnings } = await checkExitsKR(state.kr, d);
  for (const w of warnings) appendLog(w);
  for (const e of exits) {
    appendLog(`- [KR 매도] ${e.ticker} ${e.name || ''} - ${e.exitReason} @ ${e.exitPrice} (진입 ${e.entryPrice}) 손익 ${Math.round(e.pnl).toLocaleString()}원`);
    state.kr.trades.push(e);
  }
  const krOpenSlots = MAX_SLOTS - state.kr.positions.length;
  if (krOpenSlots > 0) {
    const { candidates, total, failCount } = await scanKR();
    if (failCount > 0) appendLog(`- [KR] 스캔 대상 ${total}개 중 ${failCount}개 조회 실패(정상범위, 아래 결과는 나머지 ${total - failCount}개 기준)`);
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
}

/**
 * US 시장 전체 처리. KR과 완전히 독립적으로 실행되며, 이 함수가 실패해도
 * main()에서 KR 결과는 이미 반영된 상태로 saveState()가 실행됨.
 */
async function processUS(state, d) {
  const { exits, warnings } = await checkExitsUS(state.us, d);
  for (const w of warnings) appendLog(w);
  for (const e of exits) {
    appendLog(`- [US 매도] ${e.ticker} - ${e.exitReason} @ $${e.exitPrice} (진입 $${e.entryPrice}) 손익 $${e.pnl.toFixed(2)}`);
    state.us.trades.push(e);
  }
  const usOpenSlots = MAX_SLOTS - state.us.positions.length;
  if (usOpenSlots > 0) {
    const { candidates, total, failCount } = await scanUS();
    if (failCount > 0) appendLog(`- [US] 스캔 대상 ${total}개 중 ${failCount}개 조회 실패(정상범위, 아래 결과는 나머지 ${total - failCount}개 기준)`);
    const held = new Set(state.us.positions.map(p => p.ticker));
    const picks = candidates.filter(c => !held.has(c.ticker)).slice(0, usOpenSlots);
    const allocPerSlot = (USD_CAPITAL_KRW_EQUIV / state.us.fxRateAtStart) / MAX_SLOTS;
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
}

async function main() {
  const state = loadState();
  const d = today();

  // 2026-08-28 발견된 버그 수정: 같은 실행환경(로컬 수동실행 + 클라우드 루틴 + 이후
  // Railway cron 등)이 하루에 두 번 이상 트리거되거나, 크론이 주말에도 그대로 도는 경우
  // dayCount가 실제 거래일과 어긋나게 이중 증가하는 사고가 있었음 (8/22·8/23 주말 실행,
  // 8/28 당일 중복 실행 등 - 다행히 당시 데이터 소스 장애로 실거래 왜곡은 없었음이
  // scratch_kr_reconstruct.js/log.md 대조로 확인됨). 아래 두 가드로 재발 차단:
  if (state.lastRunDate === d) {
    console.log(`이미 오늘(${d}) 처리 완료 - 중복 실행 스킵`);
    return;
  }
  if (isWeekend(d)) {
    state.lastRunDate = d;
    saveState(state);
    appendLog(`\n## ${d} (주말, 거래일 아님 - 스킵)\n`);
    console.log(`주말(${d}) - 스킵`);
    return;
  }

  state.dayCount++;
  state.lastRunDate = d;
  appendLog(`\n## ${d} (Day ${state.dayCount})\n`);

  if (state.us.fxRateAtStart === null) {
    try {
      const fx = await fetchFx();
      state.us.fxRateAtStart = fx;
      state.us.cashUsd = USD_CAPITAL_KRW_EQUIV / fx;
      appendLog(`- 시작 환율: 1 USD = ${fx.toFixed(2)} KRW, 달러 포트폴리오 시작자본: $${state.us.cashUsd.toFixed(2)}`);
    } catch (err) {
      appendLog(`- [US 경고] 환율 조회 실패, 이번 회차는 US 처리를 건너뜀: ${err.message}`);
    }
  }

  // KR과 US는 서로 완전히 독립 - 한쪽이 통째로 죽어도 다른 쪽 결과는 보존됨
  try {
    await processKR(state, d);
  } catch (err) {
    appendLog(`- [KR 오류] 이번 회차 KR 처리 실패, 다음 회차에 재시도: ${err.message}`);
  }

  if (state.us.fxRateAtStart !== null) {
    try {
      await processUS(state, d);
    } catch (err) {
      appendLog(`- [US 오류] 이번 회차 US 처리 실패, 다음 회차에 재시도: ${err.message}`);
    }
  }

  saveState(state);
  appendLog(`- KR 현금: ${Math.round(state.kr.cash).toLocaleString()}원, 보유 ${state.kr.positions.length}종목 / US 현금: $${state.us.cashUsd !== null ? state.us.cashUsd.toFixed(2) : '-'}, 보유 ${state.us.positions.length}종목`);
  console.log('done, day', state.dayCount);
}

main().catch(e => { appendLog(`- FATAL ERROR (state 저장 안 됨): ${e.message}`); console.error(e); process.exit(1); });
