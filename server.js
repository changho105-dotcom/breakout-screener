const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');

const { classifyMarketRegime, evaluateStock, LOOKBACK_OPTIONS } = require('./lib/indicators');
const { runBreakoutBacktest } = require('./lib/backtest');
const { runBatched } = require('./lib/batch');
const krSource = require('./lib/krSource');
const usSource = require('./lib/usSource');

const app = express();
const PORT = process.env.PORT || 3000;

// 스크리닝 결과 캐시 (크롤링 부하 방지). 기본 30분 - 필요시 조정.
const cache = new NodeCache({ stdTTL: 60 * 30 });

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

async function screenKR(lookbackKey) {
  const { key, days: lookbackDays } = resolveLookback(lookbackKey);
  const cacheKey = `kr_${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [kospiList, kosdaqList] = await Promise.all([
    krSource.fetchStockList(0, 4), // 코스피 상위 ~200
    krSource.fetchStockList(1, 4), // 코스닥 상위 ~200
  ]);
  const stockList = [...kospiList, ...kosdaqList];

  const [kospiIdx, kosdaqIdx] = await Promise.all([
    krSource.fetchIndexOHLCV('KOSPI', 280),
    krSource.fetchIndexOHLCV('KOSDAQ', 280),
  ]);
  const regimeByMarket = {
    KOSPI: classifyMarketRegime(kospiIdx.closes),
    KOSDAQ: classifyMarketRegime(kosdaqIdx.closes),
  };
  const indexClosesByMarket = {
    KOSPI: kospiIdx.closes,
    KOSDAQ: kosdaqIdx.closes,
  };

  const evaluated = await runBatched(stockList, async (stock) => {
    const ohlcv = await krSource.fetchOHLCV(stock.ticker, 280);
    if (!ohlcv.closes.length) return null;
    return evaluateStock({
      ticker: stock.ticker,
      name: stock.name,
      sector: null, // MVP: 국내 업종 데이터는 후속 단계에서 추가 (네이버 업종 페이지 별도 크롤링 필요)
      highs: ohlcv.highs,
      closes: ohlcv.closes,
      volumes: ohlcv.volumes,
      indexCloses: indexClosesByMarket[stock.market],
      indexRegime: regimeByMarket[stock.market],
      sectorAvgReturn: null,
      market: 'KR',
      lookback: lookbackDays,
    });
  }, 8);

  const result = {
    updatedAt: new Date().toISOString(),
    lookback: key,
    regime: regimeByMarket,
    stocks: evaluated.sort((a, b) => b.score - a.score),
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
  const allIndexOhlcv = await usSource.fetchAllIndexOHLCV(280);
  const regime = {
    SP500: classifyMarketRegime(allIndexOhlcv.SP500.closes),
    DOW: classifyMarketRegime(allIndexOhlcv.DOW.closes),
    NASDAQ: classifyMarketRegime(allIndexOhlcv.NASDAQ.closes),
  };
  // 개별 종목 평가(RS·포지션비중)는 S&P500을 대표 지수로 사용 (다우/나스닥은 화면에 참고용 게이지로만 표시)
  const primaryIndexCloses = allIndexOhlcv.SP500.closes;
  const primaryRegime = regime.SP500;

  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await usSource.fetchOHLCV(stock.ticker, 280);
    if (!ohlcv.closes.length) return null;
    return { stock, ohlcv };
  }, 10);

  // 섹터 강도: 섹터별 60일 평균 수익률 계산
  const sectorReturns = {};
  for (const { stock, ohlcv } of withOhlcv) {
    const ret = returnOverDays(ohlcv.closes, 60);
    if (ret === null) continue;
    if (!sectorReturns[stock.sector]) sectorReturns[stock.sector] = [];
    sectorReturns[stock.sector].push(ret);
  }
  const sectorAvg = {};
  for (const [sector, rets] of Object.entries(sectorReturns)) {
    sectorAvg[sector] = rets.reduce((a, b) => a + b, 0) / rets.length;
  }

  const evaluated = withOhlcv.map(({ stock, ohlcv }) =>
    evaluateStock({
      ticker: stock.ticker,
      name: stock.name,
      sector: stock.sector,
      highs: ohlcv.highs,
      closes: ohlcv.closes,
      volumes: ohlcv.volumes,
      indexCloses: primaryIndexCloses,
      indexRegime: primaryRegime,
      sectorAvgReturn: sectorAvg[stock.sector] ?? null,
      market: 'US',
      lookback: lookbackDays,
    })
  );

  const result = {
    updatedAt: new Date().toISOString(),
    lookback: key,
    regime,
    sectorAvg,
    stocks: evaluated.sort((a, b) => b.score - a.score),
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

app.get('/api/backtest/us/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const { key: lookbackKey, days: lookbackDays } = resolveLookback(req.query.lookback);
  const cacheKey = `backtest_us_${ticker}_${lookbackKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = 1260; // 약 5년치 일봉 (신고가 워밍업 이후에도 충분한 검증 기간 확보 위해 확장)
    const [stockOhlcv, indexOhlcv] = await Promise.all([
      usSource.fetchOHLCV(ticker, days),
      usSource.fetchIndexOHLCV(days),
    ]);
    if (!stockOhlcv.closes.length) {
      return res.status(404).json({ error: `${ticker} 데이터를 찾을 수 없습니다 (티커 확인 필요)` });
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
    });

    const payload = { ticker, lookback: lookbackKey, periodDays: len, ...result };
    cache.set(cacheKey, payload, 60 * 60); // 1시간 캐시
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lookback-options', (req, res) => {
  res.json(LOOKBACK_OPTIONS);
});

app.listen(PORT, () => console.log(`breakout-screener listening on ${PORT}`));
