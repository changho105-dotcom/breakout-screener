// ============================================================
// 미국 주식 데이터 소스
// - 종목 리스트(S&P500 + GICS 섹터): raw.githubusercontent.com
// - OHLCV: Yahoo Finance Chart API (query1.finance.yahoo.com)
//   → stooq.com이 Railway 같은 클라우드/데이터센터 IP를 막는 것으로
//     보여 Yahoo Finance로 교체함. 이 도메인도 샌드박스에서는 접속이
//     막혀있어 실시간 검증은 Railway 배포 후 확인 필요.
// ============================================================

const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

const SP500_LIST_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// MVP 단계에서는 요청량을 줄이기 위해 시가총액 상위 N개만 스캔 (환경변수로 조정 가능)
const US_UNIVERSE_LIMIT = Number(process.env.US_UNIVERSE_LIMIT || 150);

async function fetchStockList() {
  const res = await fetch(SP500_LIST_URL);
  const csv = await res.text();
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const list = rows.map(r => ({
    ticker: r.Symbol,
    name: r.Security,
    sector: r['GICS Sector'],
    market: 'US',
  }));
  return list.slice(0, US_UNIVERSE_LIMIT);
}

/**
 * Yahoo Finance Chart API에서 일봉 OHLCV 가져오기
 * symbol 예: 'AAPL', 지수는 '^GSPC' (S&P500)
 */
async function fetchOHLCVFromYahoo(symbol, days = 100) {
  const range = days > 200 ? '2y' : '6mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Yahoo Finance 응답 오류 (${symbol}): 상태코드 ${res.status}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const errMsg = json?.chart?.error?.description || '알 수 없는 오류';
    throw new Error(`Yahoo Finance 데이터 없음 (${symbol}): ${errMsg}`);
  }
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`Yahoo Finance quote 필드 없음 (${symbol})`);

  // null 값(휴장일 등) 제거하면서 정렬 유지
  const opens = [], highs = [], lows = [], closes = [], volumes = [];
  for (let i = 0; i < (quote.close || []).length; i++) {
    if (quote.close[i] === null || quote.close[i] === undefined) continue;
    opens.push(quote.open[i]);
    highs.push(quote.high[i]);
    lows.push(quote.low[i]);
    closes.push(quote.close[i]);
    volumes.push(quote.volume[i]);
  }
  const slice = (arr) => arr.slice(-days);
  return {
    opens: slice(opens),
    highs: slice(highs),
    lows: slice(lows),
    closes: slice(closes),
    volumes: slice(volumes),
  };
}

async function fetchOHLCV(ticker, days = 100) {
  return fetchOHLCVFromYahoo(ticker, days);
}

async function fetchIndexOHLCV(days = 100) {
  return fetchOHLCVFromYahoo('^GSPC', days); // S&P500 지수
}

module.exports = { fetchStockList, fetchOHLCV, fetchIndexOHLCV };
