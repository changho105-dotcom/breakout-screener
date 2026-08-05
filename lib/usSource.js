// ============================================================
// 미국 주식 데이터 소스
// - 종목 리스트(S&P500 + GICS 섹터): raw.githubusercontent.com
//   → 이 도메인은 샌드박스에서 접속 확인 및 응답 검증 완료
// - OHLCV: stooq.com CSV
//   → 배포 후 실데이터로 검증 완료. 다만 stooq는 짧은 시간에
//     요청이 몰리면 사용량 제한에 걸려 CSV 대신 안내 문구를
//     돌려줄 수 있어서, 그 경우를 명확한 에러로 걸러냄.
// ============================================================

const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

const SP500_LIST_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// MVP 단계에서는 요청량(=stooq 사용량 제한 리스크)을 줄이기 위해
// 시가총액 상위 N개만 스캔. 필요하면 늘릴 수 있음 (환경변수로 조정 가능).
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
 * stooq CSV 형식: Date,Open,High,Low,Close,Volume (헤더 포함, 날짜 오름차순)
 * 사용량 제한/오류 시 CSV가 아닌 안내 문구가 오므로 명확히 걸러서 에러로 던짐
 */
function parseStooqCSV(csv, context) {
  const trimmed = (csv || '').trim();
  if (!trimmed || !trimmed.startsWith('Date,')) {
    throw new Error(`stooq 응답이 CSV 형식이 아님 (${context}): "${trimmed.slice(0, 80)}"`);
  }
  const rows = parse(trimmed, { columns: true, skip_empty_lines: true });
  if (!rows.length) {
    throw new Error(`stooq 응답에 데이터 없음 (${context})`);
  }
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
  const res = await fetch(url, { headers: HEADERS });
  const csv = await res.text();
  const parsed = parseStooqCSV(csv, ticker);
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
  const res = await fetch(url, { headers: HEADERS });
  const csv = await res.text();
  const parsed = parseStooqCSV(csv, '^spx index');
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
