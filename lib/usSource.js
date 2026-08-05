// ============================================================
// 미국 주식 데이터 소스
// - 종목 리스트: 다우30 + 나스닥100 + S&P500 통합 (중복 제거)
//   · S&P500 + GICS 섹터: raw.githubusercontent.com (datasets/s-and-p-500-companies)
//   · 다우30 / 나스닥100: yfiua.github.io/index-constituents (Yahoo Finance 심볼 기준으로 정리된 공개 데이터셋)
// - 지수(국면 판별용): S&P500(^GSPC) / 다우(^DJI) / 나스닥종합(^IXIC) 3개 각각 계산
// - OHLCV: Yahoo Finance Chart API
//   → 이 파일의 새 도메인들(yfiua.github.io 등)은 샌드박스에서 접속이
//     막혀있어 실시간 검증 못함. Railway 배포 후 꼭 확인해주세요.
// ============================================================

const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

const SP500_LIST_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';
const DOW_LIST_URL = 'https://yfiua.github.io/index-constituents/constituents-dowjones.csv';
const NASDAQ100_LIST_URL = 'https://yfiua.github.io/index-constituents/constituents-nasdaq100.csv';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// 최종 스캔 종목 수 상한 (요청량 조절용, 환경변수로 조정 가능)
// 다우30 + 나스닥100은 항상 포함하고, 남는 자리를 S&P500 종목으로 채움
const US_UNIVERSE_LIMIT = Number(process.env.US_UNIVERSE_LIMIT || 250);

/** yfiua 데이터셋은 컬럼명이 symbol/Symbol/ticker 등으로 다를 수 있어 방어적으로 파싱 */
function extractTickerRows(csv) {
  const trimmed = (csv || '').trim();
  if (!trimmed) return [];
  const rows = parse(trimmed, { columns: true, skip_empty_lines: true });
  return rows.map(r => {
    const symbolKey = Object.keys(r).find(k => /symbol|ticker/i.test(k));
    const nameKey = Object.keys(r).find(k => /name|security|company/i.test(k));
    return {
      ticker: symbolKey ? r[symbolKey] : null,
      name: nameKey ? r[nameKey] : (symbolKey ? r[symbolKey] : null),
    };
  }).filter(r => r.ticker);
}

async function fetchStockList() {
  const [sp500Res, dowRes, ndxRes] = await Promise.all([
    fetch(SP500_LIST_URL),
    fetch(DOW_LIST_URL),
    fetch(NASDAQ100_LIST_URL),
  ]);
  const [sp500Csv, dowCsv, ndxCsv] = await Promise.all([sp500Res.text(), dowRes.text(), ndxRes.text()]);

  const sp500Rows = parse(sp500Csv.trim(), { columns: true, skip_empty_lines: true });
  const sectorByTicker = {};
  const sp500List = sp500Rows.map(r => {
    sectorByTicker[r.Symbol] = r['GICS Sector'];
    return { ticker: r.Symbol, name: r.Security };
  });

  const dowList = extractTickerRows(dowCsv);
  const ndxList = extractTickerRows(ndxCsv);

  // 다우30 + 나스닥100을 우선 포함하고, S&P500으로 나머지 자리를 채움 (중복 제거)
  const seen = new Set();
  const merged = [];
  for (const item of [...dowList, ...ndxList, ...sp500List]) {
    if (seen.has(item.ticker)) continue;
    seen.add(item.ticker);
    merged.push({
      ticker: item.ticker,
      name: item.name,
      sector: sectorByTicker[item.ticker] || 'Other',
      market: 'US',
    });
    if (merged.length >= US_UNIVERSE_LIMIT) break;
  }
  return merged;
}

/**
 * Yahoo Finance Chart API에서 일봉 OHLCV 가져오기
 * symbol 예: 'AAPL', 지수는 '^GSPC'(S&P500) / '^DJI'(다우) / '^IXIC'(나스닥종합)
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

/**
 * 3대 지수(S&P500/다우/나스닥종합)를 각각 가져옴.
 * 종목 평가(RS·포지션비중)의 기준 지수는 S&P500(^GSPC)을 대표값으로 사용하고,
 * 다우·나스닥은 화면에 국면 게이지로만 별도 표시 (참고용).
 */
async function fetchAllIndexOHLCV(days = 100) {
  const [sp500, dow, nasdaq] = await Promise.all([
    fetchOHLCVFromYahoo('^GSPC', days),
    fetchOHLCVFromYahoo('^DJI', days),
    fetchOHLCVFromYahoo('^IXIC', days),
  ]);
  return { SP500: sp500, DOW: dow, NASDAQ: nasdaq };
}

async function fetchIndexOHLCV(days = 100) {
  return fetchOHLCVFromYahoo('^GSPC', days); // 하위호환용 - S&P500 단독
}

module.exports = { fetchStockList, fetchOHLCV, fetchIndexOHLCV, fetchAllIndexOHLCV };
