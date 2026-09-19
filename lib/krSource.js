// ============================================================
// 국내(코스피/코스닥) 데이터 소스 - 네이버 금융 크롤링
//
// ⚠️ 중요: 이 파일은 개발 샌드박스에서 finance.naver.com에 직접
// 접속할 수 없어서 실시간으로 검증하지 못했습니다. Railway에
// 배포한 뒤 /api/screen/kr 을 한 번 호출해서 정상 동작하는지
// 반드시 확인해주세요. 네이버가 페이지 구조를 바꾸면 cheerio
// 셀렉터(parseStockList 함수)가 깨질 수 있습니다 - 이 경우
// 응답 형식은 그대로 유지되고 빈 배열이 오는 형태로 실패하니
// 콘솔 로그를 확인하시면 됩니다.
// ============================================================

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

/**
 * 시가총액 상위 종목 리스트 가져오기 (페이지당 50개, pages장 만큼)
 * sosok: 0 = 코스피, 1 = 코스닥
 *
 * 2026-09-19: 기존에 쓰던 finance.naver.com/sise/sise_market_sum.naver(구형 서버렌더링
 * HTML, table.type_2/a.tltle 셀렉터)가 네이버가 이 페이지를 Next.js SPA로 전면 개편하면서
 * 완전히 사라짐(HTML에 해당 클래스가 아예 없음 확인) - res.ok는 200으로 정상인데 파싱 결과가
 * 0개가 나오는 상황이었고, 2026-08-29에 추가해둔 MIN_UNIVERSE_KR 최소개수 체크(daily_update.js)
 * 가 실제로 이 사고를 잡아내서 9/11부터 KR 스캔이 명시적 에러로 표시됨(침묵 실패 아님).
 * → 네이버 모바일 증권이 쓰는 JSON API(m.stock.naver.com)로 교체. 이 페이지는 HTML을 안 쓰고
 * 이 API를 직접 호출해서 데이터를 받아오므로 더 안정적일 것으로 기대되나, 이것도 언젠가
 * 바뀔 수 있으니 아래 MIN_UNIVERSE 체크는 그대로 유지해야 함.
 */
async function fetchStockList(sosok, pages = 4) {
  const category = sosok === 0 ? 'KOSPI' : 'KOSDAQ';
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://m.stock.naver.com/api/stocks/marketValue/${category}?page=${page}&pageSize=50`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const bodyPreview = (await res.text()).slice(0, 200);
      throw new Error(`네이버 종목리스트 응답 오류 (${category}, page=${page}): 상태코드 ${res.status} - ${bodyPreview}`);
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new Error(`네이버 종목리스트 JSON 파싱 실패 (${category}, page=${page}): ${err.message}`);
    }
    const stocks = json?.stocks || [];
    for (const s of stocks) {
      if (!s.itemCode) continue;
      results.push({ ticker: s.itemCode, name: s.stockName, market: category });
    }
    if (stocks.length === 0) break; // 마지막 페이지(더 이상 종목 없음) - 불필요한 요청 방지
  }
  return results;
}

/**
 * 개별 종목/지수 OHLCV 가져오기 (일봉, count일)
 * symbol: 종목코드(예: '005930') 또는 지수코드('KOSPI', 'KOSDAQ')
 */
async function fetchOHLCV(symbol, count = 100) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const bodyPreview = (await res.text()).slice(0, 200);
    throw new Error(`네이버 OHLCV 응답 오류 (${symbol}): 상태코드 ${res.status} - ${bodyPreview}`);
  }
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const opens = [], highs = [], lows = [], closes = [], volumes = [], dates = [];
  $('item').each((_, el) => {
    const data = $(el).attr('data'); // "20240102|71000|71400|70600|71200|12345678"
    if (!data) return;
    const [date, open, high, low, close, volume] = data.split('|');
    opens.push(Number(open));
    highs.push(Number(high));
    lows.push(Number(low));
    closes.push(Number(close));
    volumes.push(Number(volume));
    dates.push(date ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` : null);
  });

  return { opens, highs, lows, closes, volumes, dates };
}

async function fetchIndexOHLCV(market, count = 100) {
  const symbol = market === 'KOSPI' ? 'KOSPI' : 'KOSDAQ';
  return fetchOHLCV(symbol, count);
}

/**
 * 업종(섹터) 목록 가져오기 - 네이버 "업종별 시세" 페이지
 * 반환: [{ no, name }] - no는 업종 상세 페이지 조회용 번호
 *
 * ⚠️ 이 함수와 아래 fetchSectorMap도 샌드박스에서 검증 못했습니다.
 * 네이버 페이지 구조가 예상과 다르면 빈 배열/빈 맵을 반환하도록
 * 방어적으로 짰으니, 실패해도 스크리너 전체가 죽지는 않습니다
 * (섹터 데이터만 null로 빠지고 나머지는 정상 동작).
 */
async function fetchSectorList() {
  const url = 'https://finance.naver.com/sise/sise_group.naver?type=upjong';
  const res = await fetch(url, { headers: HEADERS });
  const buffer = await res.buffer();
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const sectors = [];
  $('a[href*="sise_group_detail.naver"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/no=(\d+)/);
    const name = $(el).text().trim();
    if (match && name) sectors.push({ no: match[1], name });
  });
  return sectors;
}

/**
 * 업종 하나에 속한 종목 코드 목록
 */
async function fetchSectorConstituents(sectorNo) {
  const url = `https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=${sectorNo}`;
  const res = await fetch(url, { headers: HEADERS });
  const buffer = await res.buffer();
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const tickers = [];
  $('a[href*="code="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/code=(\d{6})/);
    if (match) tickers.push(match[1]);
  });
  return tickers;
}

/**
 * 전체 업종 맵 { ticker: sectorName } 만들기.
 * 업종 수가 많아(보통 60~80개) 요청이 꽤 걸리므로 호출부에서 캐시(TTL 길게) 필수.
 */
async function fetchSectorMap() {
  try {
    const sectors = await fetchSectorList();
    const map = {};
    const { runBatched } = require('./batch');
    await runBatched(sectors, async (sector) => {
      const tickers = await fetchSectorConstituents(sector.no);
      for (const t of tickers) {
        if (!map[t]) map[t] = sector.name; // 이미 배정된 종목은 첫 매칭 유지
      }
    }, 8);
    return map;
  } catch (err) {
    console.warn('[krSource] 업종 맵 크롤링 실패, 섹터 없이 진행:', err.message);
    return {};
  }
}

module.exports = { fetchStockList, fetchOHLCV, fetchIndexOHLCV, fetchSectorMap };
