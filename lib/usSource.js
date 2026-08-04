// ============================================================
// 미국 주식 데이터 소스
// - 종목 리스트(S&P500 + GICS 섹터): raw.githubusercontent.com
//   → 이 도메인은 샌드박스에서 접속 확인 및 응답 검증 완료
// - OHLCV: stooq.com CSV
//   → ⚠️ 샌드박스에서 stooq.com 접속이 막혀있어 실시간 검증 못함.
//     Railway 배포 후 /api/screen/us 호출로 꼭 확인해주세요.
//     혹시 stooq 응답 형식이 다르면 parseStooqCSV 함수만 손보면 됩니다.
// ============================================================

const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

const SP500_LIST_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';

async function fetchStockList() {
  const res = await fetch(SP500_LIST_URL);
  const csv = await res.text();
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  return rows.map(r => ({
    ticker: r.Symbol,
    name: r.Security,
    sector: r['GICS Sector'],
    market: 'US',
  }));
}

/**
 * stooq CSV 형식: Date,Open,High,Low,Close,Volume (헤더 포함, 날짜 오름차순)
 */
function parseStooqCSV(csv) {
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const opens = [], highs = [], lows = [], closes = [], volumes = [];
  for (const r of rows) {
    opens.push(Number(r.Open));
    highs.push(Number(r.High));
    lows.push(Number(r.Low));
    closes.push(Number(r.Close));
    volumes.push(Number(r.Volume));
  }
  return { opens, highs, lows, closes, volumes };
}

async function fetchOHLCV(ticker, days = 100) {
  // stooq는 종목 심볼을 소문자.us 형식으로 요구 (예: aapl.us)
  const symbol = `${ticker.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;
  const res = await fetch(url);
  const csv = await res.text();
  const parsed = parseStooqCSV(csv);
  // 최근 days개만 사용
  const slice = (arr) => arr.slice(-days);
  return {
    opens: slice(parsed.opens),
    highs: slice(parsed.highs),
    lows: slice(parsed.lows),
    closes: slice(parsed.closes),
    volumes: slice(parsed.volumes),
  };
}

async function fetchIndexOHLCV(days = 100) {
  // S&P500 지수: stooq 심볼은 ^spx (URL 인코딩 필요)
  const url = `https://stooq.com/q/d/l/?s=%5Espx&i=d`;
  const res = await fetch(url);
  const csv = await res.text();
  const parsed = parseStooqCSV(csv);
  const slice = (arr) => arr.slice(-days);
  return {
    opens: slice(parsed.opens),
    highs: slice(parsed.highs),
    lows: slice(parsed.lows),
    closes: slice(parsed.closes),
    volumes: slice(parsed.volumes),
  };
}

module.exports = { fetchStockList, fetchOHLCV, fetchIndexOHLCV };
