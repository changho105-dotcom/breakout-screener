const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');

const { classifyMarketRegime, evaluateStock, checkBreakout, computeRsRatings, LOOKBACK_OPTIONS } = require('./lib/indicators');
const { runBreakoutBacktest } = require('./lib/backtest');
const { runBatched } = require('./lib/batch');
const krSource = require('./lib/krSource');
const usSource = require('./lib/usSource');

const app = express();
const PORT = process.env.PORT || 3000;

// 스크리닝 결과 캐시 (크롤링 부하 방지). 기본 30분 - 필요시 조정.
const cache = new NodeCache({ stdTTL: 60 * 30 });
// 업종(섹터) 맵 전용 캐시 - 자주 안 바뀌는 데이터라 24시간으로 길게
const SECTOR_MAP_TTL = 60 * 60 * 24;

app.use(express.static(path.join(__dirname, 'public')));

/**
 * N일 수익률 (섹터 강도 계산용 공용 함수)
 */
function returnOverDays(closes, days) {
  if (closes.length < days + 1) return null;
  return closes[closes.length - 1] / closes[closes.length - 1 - days] - 1;
}

const DEFAULT_LOOKBACK_KEY = '36w';
function resolveLookback(queryValue) {
  const key = LOOKBACK_OPTIONS[queryValue] ? queryValue : DEFAULT_LOOKBACK_KEY;
  return { key, days: LOOKBACK_OPTIONS[key].days };
}

/**
 * 섹터별 N일 평균 수익률(섹터 강도) 계산 - KR/US 공용
 */
function computeSectorAvg(itemsWithSectorAndCloses, days = 60) {
  const sectorReturns = {};
  for (const { sector, closes } of itemsWithSectorAndCloses) {
    const ret = returnOverDays(closes, days);
    if (ret === null || !sector) continue;
    if (!sectorReturns[sector]) sectorReturns[sector] = [];
    sectorReturns[sector].push(ret);
  }
  const sectorAvg = {};
  for (const [sector, rets] of Object.entries(sectorReturns)) {
    sectorAvg[sector] = rets.reduce((a, b) => a + b, 0) / rets.length;
  }
  return sectorAvg;
}

/**
 * 국내 업종 맵 - 24시간 캐시. 크롤링 실패해도 빈 맵({})으로 안전하게 진행.
 */
async function getKrSectorMap() {
  const cacheKey = 'kr_sector_map';
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const map = await krSource.fetchSectorMap();
  cache.set(cacheKey, map, SECTOR_MAP_TTL);
  return map;
}

async function screenKR(lookbackKey) {
  const { key, days: lookbackDays } = resolveLookback(lookbackKey);
  const cacheKey = `kr_${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [kospiList, kosdaqList, sectorMap] = await Promise.all([
    krSource.fetchStockList(0, 4), // 코스피 상위 ~200
    krSource.fetchStockList(1, 4), // 코스닥 상위 ~200
    getKrSectorMap(),
  ]);
  const stockList = [...kospiList, ...kosdaqList];

  const [kospiIdx, kosdaqIdx] = await Promise.all([
    krSource.fetchIndexOHLCV('KOSPI', 300),
    krSource.fetchIndexOHLCV('KOSDAQ', 300),
  ]);
  const regimeByMarket = {
    KOSPI: classifyMarketRegime(kospiIdx.closes),
    KOSDAQ: classifyMarketRegime(kosdaqIdx.closes),
  };
  const indexClosesByMarket = {
    KOSPI: kospiIdx.closes,
    KOSDAQ: kosdaqIdx.closes,
  };

  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await krSource.fetchOHLCV(stock.ticker, 300);
    if (!ohlcv.closes.length) return null;
    return { stock, ohlcv, sector: sectorMap[stock.ticker] || null };
  }, 8);
  const fetchFailures = stockList.length - withOhlcv.length;

  const sectorAvg = computeSectorAvg(withOhlcv.map(({ sector, ohlcv }) => ({ sector, closes: ohlcv.closes })), 60);
  const rsRatings = computeRsRatings(withOhlcv.map(({ stock, ohlcv }) => ({ key: stock.ticker, closes: ohlcv.closes })), lookbackDays);

  const evaluated = withOhlcv.map(({ stock, ohlcv, sector }) =>
    evaluateStock({
      ticker: stock.ticker,
      name: stock.name,
      sector,
      highs: ohlcv.highs,
      closes: ohlcv.closes,
      lows: ohlcv.lows,
      volumes: ohlcv.volumes,
      indexCloses: indexClosesByMarket[stock.market],
      indexRegime: regimeByMarket[stock.market],
      sectorAvgReturn: sector ? sectorAvg[sector] ?? null : null,
      market: 'KR',
      lookback: lookbackDays,
      rsRatingPercentile: rsRatings[stock.ticker] ?? null,
    })
  );
  const liquidStocks = evaluated.filter(s => s.liquidityOk);
  const excludedForLiquidity = evaluated.length - liquidStocks.length;

  const result = {
    updatedAt: new Date().toISOString(),
    lookback: key,
    regime: regimeByMarket,
    sectorAvg,
    sectorCoverage: `${Object.keys(sectorMap).length}종목 매칭`, // 업종 크롤링이 실패하면 0종목으로 나타남
    excludedForLiquidity, // 유동성 미달로 결과에서 제외된 종목 수
    fetchFailures, // 데이터 조회 자체가 실패한 종목 수 (소스 이슈 감지용)
    stocks: liquidStocks.sort((a, b) => b.score - a.score),
  };
  cache.set(cacheKey, result);
  return result;
}

async function screenUS(lookbackKey) {
  const { key, days: lookbackDays } = resolveLookback(lookbackKey);
  const cacheKey = `us_${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const stockList = await usSource.fetchStockList();
  const allIndexOhlcv = await usSource.fetchAllIndexOHLCV(300);
  const regime = {
    SP500: classifyMarketRegime(allIndexOhlcv.SP500.closes),
    DOW: classifyMarketRegime(allIndexOhlcv.DOW.closes),
    NASDAQ: classifyMarketRegime(allIndexOhlcv.NASDAQ.closes),
  };
  // 개별 종목 평가(RS·포지션비중)는 S&P500을 대표 지수로 사용 (다우/나스닥은 화면에 참고용 게이지로만 표시)
  const primaryIndexCloses = allIndexOhlcv.SP500.closes;
  const primaryRegime = regime.SP500;

  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await usSource.fetchOHLCV(stock.ticker, 300);
    if (!ohlcv.closes.length) return null;
    return { stock, ohlcv };
  }, 10);
  const fetchFailures = stockList.length - withOhlcv.length;

  const sectorAvg = computeSectorAvg(withOhlcv.map(({ stock, ohlcv }) => ({ sector: stock.sector, closes: ohlcv.closes })), 60);
  const rsRatings = computeRsRatings(withOhlcv.map(({ stock, ohlcv }) => ({ key: stock.ticker, closes: ohlcv.closes })), lookbackDays);

  const evaluated = withOhlcv.map(({ stock, ohlcv }) =>
    evaluateStock({
      ticker: stock.ticker,
      name: stock.name,
      sector: stock.sector,
      highs: ohlcv.highs,
      closes: ohlcv.closes,
      lows: ohlcv.lows,
      volumes: ohlcv.volumes,
      indexCloses: primaryIndexCloses,
      indexRegime: primaryRegime,
      sectorAvgReturn: sectorAvg[stock.sector] ?? null,
      market: 'US',
      lookback: lookbackDays,
      rsRatingPercentile: rsRatings[stock.ticker] ?? null,
    })
  );
  const liquidStocks = evaluated.filter(s => s.liquidityOk);
  const excludedForLiquidity = evaluated.length - liquidStocks.length;

  const result = {
    updatedAt: new Date().toISOString(),
    lookback: key,
    regime,
    sectorAvg,
    excludedForLiquidity,
    fetchFailures,
    stocks: liquidStocks.sort((a, b) => b.score - a.score),
  };
  cache.set(cacheKey, result);
  return result;
}

app.get('/api/screen/kr', async (req, res) => {
  try {
    const data = await screenKR(req.query.lookback);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screen/us', async (req, res) => {
  try {
    const data = await screenUS(req.query.lookback);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 단일 종목 백테스트 실행 (US/KR 공용, 단일/비교/기간비교 엔드포인트 공용 로직)
 * region: 'us' | 'kr'.  krMarket: 'KOSPI' | 'KOSDAQ' (region==='kr'일 때만 사용, 지수 비교 기준)
 */
async function runSingleBacktest(region, ticker, lookbackKey, krMarket) {
  const { key, days: lookbackDays } = resolveLookback(lookbackKey);
  const marketTag = region === 'kr' ? (krMarket === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') : 'US';
  const cacheKey = `backtest_${region}_${ticker}_${marketTag}_${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const days = region === 'kr' ? 1500 : 1260; // 국내는 영업일 기준으로 좀 더 넉넉히 (약 6년)
  const [stockOhlcv, indexOhlcv] = region === 'kr'
    ? await Promise.all([
        krSource.fetchOHLCV(ticker, days),
        krSource.fetchIndexOHLCV(marketTag, days),
      ])
    : await Promise.all([
        usSource.fetchOHLCV(ticker, days),
        usSource.fetchIndexOHLCV(days),
      ]);

  if (!stockOhlcv.closes.length) {
    const err = new Error(`${ticker} 데이터를 찾을 수 없습니다 (티커 확인 필요${region === 'kr' ? ', 코스피/코스닥 선택도 확인해주세요' : ''})`);
    err.statusCode = 404;
    throw err;
  }

  // 종목과 지수의 날짜 길이가 다를 수 있어 뒤쪽(최근) 기준으로 짧은 쪽에 맞춤
  const len = Math.min(stockOhlcv.closes.length, indexOhlcv.closes.length);
  const trim = (arr) => arr.slice(-len);

  const result = runBreakoutBacktest({
    dates: trim(stockOhlcv.dates),
    opens: trim(stockOhlcv.opens),
    highs: trim(stockOhlcv.highs),
    lows: trim(stockOhlcv.lows),
    closes: trim(stockOhlcv.closes),
    volumes: trim(stockOhlcv.volumes),
    indexCloses: trim(indexOhlcv.closes),
    lookback: lookbackDays,
    market: region === 'kr' ? 'KR' : 'US',
  });

  const payload = { ticker, region, market: region === 'kr' ? marketTag : 'US', lookback: key, periodDays: len, ...result };
  cache.set(cacheKey, payload, 60 * 60); // 1시간 캐시
  return payload;
}

app.get('/api/backtest/us/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const payload = await runSingleBacktest('us', ticker, req.query.lookback);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/backtest/kr/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const krMarket = (req.query.market || 'KOSPI').toUpperCase();
  try {
    const payload = await runSingleBacktest('kr', ticker, req.query.lookback, krMarket);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * 여러 종목 백테스트 비교: /api/backtest/us/compare/batch?tickers=PLTR,AME,MSFT&lookback=36w
 */
app.get('/api/backtest/us/compare/batch', async (req, res) => {
  const tickersParam = (req.query.tickers || '').trim();
  if (!tickersParam) {
    return res.status(400).json({ error: 'tickers 쿼리 파라미터가 필요합니다 (예: ?tickers=PLTR,AME)' });
  }
  const tickers = [...new Set(tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean))].slice(0, 10);

  const results = await runBatched(tickers, async (ticker) => {
    try {
      const payload = await runSingleBacktest('us', ticker, req.query.lookback);
      return { ticker, ok: true, ...payload };
    } catch (err) {
      return { ticker, ok: false, error: err.message };
    }
  }, 5);

  const ordered = tickers.map(t => results.find(r => r.ticker === t)).filter(Boolean);
  res.json({ lookback: resolveLookback(req.query.lookback).key, results: ordered });
});

app.get('/api/backtest/kr/compare/batch', async (req, res) => {
  const tickersParam = (req.query.tickers || '').trim();
  if (!tickersParam) {
    return res.status(400).json({ error: 'tickers 쿼리 파라미터가 필요합니다 (예: ?tickers=005930,000660)' });
  }
  const krMarket = (req.query.market || 'KOSPI').toUpperCase();
  const tickers = [...new Set(tickersParam.split(',').map(t => t.trim()).filter(Boolean))].slice(0, 10);

  const results = await runBatched(tickers, async (ticker) => {
    try {
      const payload = await runSingleBacktest('kr', ticker, req.query.lookback, krMarket);
      return { ticker, ok: true, ...payload };
    } catch (err) {
      return { ticker, ok: false, error: err.message };
    }
  }, 5);

  const ordered = tickers.map(t => results.find(r => r.ticker === t)).filter(Boolean);
  res.json({ lookback: resolveLookback(req.query.lookback).key, results: ordered });
});

/**
 * 기준 기간(60일/120일/36주/52주) 4개를 한 종목에 대해 한 번에 비교
 * /api/backtest/us/lookback-compare/PLTR  또는 /api/backtest/kr/lookback-compare/005930?market=KOSPI
 */
app.get('/api/backtest/:region/lookback-compare/:ticker', async (req, res) => {
  const { region } = req.params;
  if (region !== 'us' && region !== 'kr') {
    return res.status(400).json({ error: 'region은 us 또는 kr이어야 합니다' });
  }
  const ticker = region === 'us' ? req.params.ticker.toUpperCase() : req.params.ticker;
  const krMarket = (req.query.market || 'KOSPI').toUpperCase();
  const lookbackKeys = Object.keys(LOOKBACK_OPTIONS);

  const results = await runBatched(lookbackKeys, async (lbKey) => {
    try {
      const payload = await runSingleBacktest(region, ticker, lbKey, krMarket);
      return { lookback: lbKey, ok: true, ...payload };
    } catch (err) {
      return { lookback: lbKey, ok: false, error: err.message };
    }
  }, 4);

  const ordered = lookbackKeys.map(k => results.find(r => r.lookback === k)).filter(Boolean);
  res.json({ ticker, region, results: ordered });
});

app.get('/api/chart/kr/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const { key: lookbackKey, days: lookbackDays } = resolveLookback(req.query.lookback);
  const cacheKey = `chart_kr_${ticker}_${lookbackKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const fetchDays = Math.max(lookbackDays + 40, 260); // 차트에 여유 있게 보여주기 위해 lookback보다 좀 더 넉넉히
    const ohlcv = await krSource.fetchOHLCV(ticker, fetchDays);
    if (!ohlcv.closes.length) {
      return res.status(404).json({ error: `${ticker} 차트 데이터를 찾을 수 없습니다` });
    }
    const breakout = checkBreakout(ohlcv.highs, ohlcv.closes, ohlcv.lows, lookbackDays);
    const payload = {
      ticker,
      dates: ohlcv.dates,
      closes: ohlcv.closes,
      highs: ohlcv.highs,
      lows: ohlcv.lows,
      volumes: ohlcv.volumes,
      breakoutLevel: breakout.breakoutLevel,
      stopLossLevel: breakout.stopLossLevel,
      stopLossBasis: breakout.stopLossBasis,
    };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chart/us/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const { key: lookbackKey, days: lookbackDays } = resolveLookback(req.query.lookback);
  const cacheKey = `chart_us_${ticker}_${lookbackKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const fetchDays = Math.max(lookbackDays + 40, 260);
    const ohlcv = await usSource.fetchOHLCV(ticker, fetchDays);
    if (!ohlcv.closes.length) {
      return res.status(404).json({ error: `${ticker} 차트 데이터를 찾을 수 없습니다` });
    }
    const breakout = checkBreakout(ohlcv.highs, ohlcv.closes, ohlcv.lows, lookbackDays);
    const payload = {
      ticker,
      dates: ohlcv.dates,
      closes: ohlcv.closes,
      highs: ohlcv.highs,
      lows: ohlcv.lows,
      volumes: ohlcv.volumes,
      breakoutLevel: breakout.breakoutLevel,
      stopLossLevel: breakout.stopLossLevel,
      stopLossBasis: breakout.stopLossBasis,
    };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lookback-options', (req, res) => {
  res.json(LOOKBACK_OPTIONS);
});

/**
 * 실전 가상매매(paper trading) 트래커 현황 - 30일간 매일 갱신되는 로컬 실험용 트래커.
 * paper_trade/daily_update.js가 로컬에서 실행되어 state.json/log.md를 갱신하고 GitHub에 push하면,
 * 이 배포본이 재빌드되면서 최신 상태를 보여줌 (Railway가 GitHub push에 auto-deploy 연결돼 있어야 함).
 */
app.get('/api/paper-trade', (req, res) => {
  const fs = require('fs');
  const statePath = path.join(__dirname, 'paper_trade', 'state.json');
  const logPath = path.join(__dirname, 'paper_trade', 'log.md');
  try {
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    res.json({ state, log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`breakout-screener listening on ${PORT}`));
