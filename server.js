const express = require('express');
const path = require('path');
const NodeCache = require('node-cache');

const { classifyMarketRegime, evaluateStock } = require('./lib/indicators');
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

async function screenKR() {
  const cached = cache.get('kr');
  if (cached) return cached;

  const [kospiList, kosdaqList] = await Promise.all([
    krSource.fetchStockList(0, 4), // 코스피 상위 ~200
    krSource.fetchStockList(1, 4), // 코스닥 상위 ~200
  ]);
  const stockList = [...kospiList, ...kosdaqList];

  const [kospiIdx, kosdaqIdx] = await Promise.all([
    krSource.fetchIndexOHLCV('KOSPI'),
    krSource.fetchIndexOHLCV('KOSDAQ'),
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
    const ohlcv = await krSource.fetchOHLCV(stock.ticker);
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
    });
  }, 8);

  const result = {
    updatedAt: new Date().toISOString(),
    regime: regimeByMarket,
    stocks: evaluated.sort((a, b) => b.score - a.score),
  };
  cache.set('kr', result);
  return result;
}

async function screenUS() {
  const cached = cache.get('us');
  if (cached) return cached;

  const stockList = await usSource.fetchStockList();
  const indexOhlcv = await usSource.fetchIndexOHLCV();
  const regime = classifyMarketRegime(indexOhlcv.closes);

  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await usSource.fetchOHLCV(stock.ticker);
    if (!ohlcv.closes.length) return null;
    return { stock, ohlcv };
  }, 10);

  // 섹터 강도: 섹터별 60일 평균 수익률 계산 (RS와 동일 lookback)
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
      indexCloses: indexOhlcv.closes,
      indexRegime: regime,
      sectorAvgReturn: sectorAvg[stock.sector] ?? null,
      market: 'US',
    })
  );

  const result = {
    updatedAt: new Date().toISOString(),
    regime: { US: regime },
    sectorAvg,
    stocks: evaluated.sort((a, b) => b.score - a.score),
  };
  cache.set('us', result);
  return result;
}

app.get('/api/screen/kr', async (req, res) => {
  try {
    const data = await screenKR();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screen/us', async (req, res) => {
  try {
    const data = await screenUS();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`breakout-screener listening on ${PORT}`));
