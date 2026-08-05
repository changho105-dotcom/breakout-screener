// ============================================================
// 돌파매매 체크리스트 → 지표 계산 모듈
// 이 파일의 함수들은 스크리너 뿐 아니라 나중에 백테스터에서도
// 그대로 재사용합니다. 로직이 한 곳에만 있어야 스크리너와
// 백테스터 결과가 어긋나지 않습니다.
// ============================================================

/**
 * 설정값 - 실제로 튜닝하게 될 부분은 다 여기 모아둠
 */
const CONFIG = {
  volumeSurgeMultiple: 1.5,      // 거래량 급증 기준: 20일 평균 대비 배수
  breakoutLookback: 180,         // 돌파 판단 기준 기간 - 36주(전고점) 돌파 (거래일 기준 약 180일 = 36주*5일)
  fiftyTwoWeekLookback: 180,     // 신고가 계산 기간 (36주)
  nearHighThreshold: -0.20,      // "36주 신고가 근접" 판정 기준: 신고가 대비 -20% 이내
  minTradingValueKR: 500_000_000,   // 국내 최소 20일 평균 거래대금 (원) - 유동성 필터
  minTradingValueUS: 5_000_000,     // 미국 최소 20일 평균 거래대금 (달러)
  maShort: 20,
  maLong: 60,
  baseLookback: 20,               // 손절선 계산용 "베이스(직전 조정구간)" 길이 - 돌파 직전 20거래일 저점을 베이스 하단으로 봄
  maxBaseStopPct: -0.15,          // 베이스 하단이 돌파선 대비 이보다 더 멀면(리스크 과다) 대신 % 손절로 대체
  fallbackStopPct: -0.03,         // 베이스 하단을 못 구하거나 위 상한을 넘을 때 쓰는 대체 손절폭 (돌파선 대비 -3%)
  oneWayTradingCostPct: 0.0015,   // 백테스트 거래비용(편도, 수수료+슬리피지 가정치) - 왕복이면 대략 2배

  // ── 미너비니 트렌드 템플릿 관련 ──
  trendMaShort: 50,
  trendMaMid: 150,
  trendMaLong: 200,
  trendMaLongRisingLookback: 20,   // 200일선이 "최근 1개월(약 20거래일)간 상승 중"인지 비교할 기준
  fiftyTwoWeekLowLookback: 252,    // 52주 저점 계산 기간
  minRiseFromLowPct: 0.30,         // 52주 저점 대비 최소 상승폭 (미너비니 기준 30%)
  rsRatingThreshold: 70,           // RS Rating(현재 스캔 대상 종목군 내 백분위) 통과 기준
};

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * 시장 국면 판별
 * closes: 지수 종가 배열 (오래된 것 → 최신 순)
 * 반환: 'STRONG_UP' | 'WEAK_UP' | 'PULLBACK' | 'DOWN'
 */
function classifyMarketRegime(closes) {
  const ma20 = sma(closes, CONFIG.maShort);
  const ma60 = sma(closes, CONFIG.maLong);
  const price = closes[closes.length - 1];
  if (ma20 === null || ma60 === null) return 'UNKNOWN';

  const ma60Prev = sma(closes.slice(0, -5), CONFIG.maLong); // 5일 전 60일선 값과 비교해 기울기 판단
  const ma60Rising = ma60Prev !== null ? ma60 > ma60Prev : true;

  if (price < ma60) return 'DOWN';
  if (price < ma20) return 'PULLBACK';
  if (price >= ma20 && !ma60Rising) return 'WEAK_UP';
  return 'STRONG_UP';
}

/**
 * 국면별 매매 강도 (포지션 비중 가이드) - 봇 단계에서 실제 주문 비중에 사용
 */
function regimePositionSizeFactor(regime) {
  switch (regime) {
    case 'STRONG_UP': return 1.0;
    case 'WEAK_UP': return 0.5;
    case 'PULLBACK': return 0; // 신규진입 중단
    case 'DOWN': return 0;     // 매매 중단
    default: return 0;
  }
}

/**
 * 36주 신고가 대비 현재가 위치 (예전의 RS 자리를 대체)
 * 0 = 36주 신고가 갱신 중, 음수면 그만큼 신고가 대비 낮은 상태
 * highs: 고가 배열, closes: 종가 배열 (당일 포함)
 */
function distanceFromFiftyTwoWeekHigh(highs, closes, lookback = CONFIG.fiftyTwoWeekLookback) {
  if (highs.length < lookback || closes.length < lookback) return null;
  const high52w = Math.max(...highs.slice(-lookback));
  const lastClose = closes[closes.length - 1];
  return lastClose / high52w - 1;
}

/**
 * 거래량 급증 여부: 당일 거래량 / 최근 20일(당일 제외) 평균 거래량
 */
function volumeSurgeRatio(volumes) {
  if (volumes.length < 21) return null;
  const today = volumes[volumes.length - 1];
  const avg20 = sma(volumes.slice(0, -1), 20);
  if (!avg20) return null;
  return today / avg20;
}

/**
 * 미너비니 트렌드 템플릿 (종목 자체 이동평균선 정렬 기준, 8개 중 이동평균 관련 5개를 하나로 판정)
 * 1) 현재가 > 150일선, 200일선   2) 150일선 > 200일선
 * 3) 200일선이 최근 1개월(약 20거래일)간 상승 중   4) 50일선 > 150일선, 200일선
 * 5) 현재가 > 50일선
 * closes.length가 200+trendMaLongRisingLookback 미만이면 판단 불가(null)
 */
function checkTrendTemplate(closes) {
  const need = CONFIG.trendMaLong + CONFIG.trendMaLongRisingLookback;
  if (closes.length < need) return null;

  const price = closes[closes.length - 1];
  const ma50 = sma(closes, CONFIG.trendMaShort);
  const ma150 = sma(closes, CONFIG.trendMaMid);
  const ma200 = sma(closes, CONFIG.trendMaLong);
  const ma200Prev = sma(closes.slice(0, -CONFIG.trendMaLongRisingLookback), CONFIG.trendMaLong);
  if ([ma50, ma150, ma200, ma200Prev].some(v => v === null)) return null;

  return (
    price > ma150 &&
    price > ma200 &&
    ma150 > ma200 &&
    ma200 > ma200Prev &&
    ma50 > ma150 &&
    ma50 > ma200 &&
    price > ma50
  );
}

/**
 * RS Rating - 현재 스캔 대상 종목군 안에서 이 종목의 수익률이 몇 백분위인지 (0~100)
 * items: [{ key, closes }], days: 수익률 계산 기간
 * 반환: { key: percentile } 맵. 데이터 부족한 종목은 맵에서 제외됨.
 */
function computeRsRatings(items, days) {
  const withReturns = items
    .map(({ key, closes }) => {
      if (closes.length < days + 1) return null;
      const ret = closes[closes.length - 1] / closes[closes.length - 1 - days] - 1;
      return { key, ret };
    })
    .filter(Boolean);

  const sorted = [...withReturns].sort((a, b) => a.ret - b.ret);
  const n = sorted.length;
  const percentileMap = {};
  sorted.forEach((item, idx) => {
    percentileMap[item.key] = n > 1 ? Math.round((idx / (n - 1)) * 100) : 50;
  });
  return percentileMap;
}

/**
 * 돌파 여부 판단 - 36주 신고가(전고점) 돌파 기준
 * closes: 종가 배열, lookback(기본 36주=180거래일) 기간의 "당일 제외 최고가"를 오늘 종가가 넘었는지 확인
 * lows: 저가 배열 - 손절선(베이스 하단) 계산에 사용
 * 반환: { isBreakout, breakoutLevel, stopLossLevel, stopLossBasis }
 */
function checkBreakout(highs, closes, lows, lookback = CONFIG.breakoutLookback, baseLookback = CONFIG.baseLookback) {
  if (closes.length < lookback + 1) {
    return { isBreakout: false, breakoutLevel: null, stopLossLevel: null, stopLossBasis: null };
  }
  const priorHighs = highs.slice(-(lookback + 1), -1); // 오늘 제외 lookback일
  const breakoutLevel = Math.max(...priorHighs);
  const todayClose = closes[closes.length - 1];
  const isBreakout = todayClose > breakoutLevel;

  // 손절선: 돌파 직전 베이스(조정구간) 하단을 우선 사용하고,
  // 베이스 하단이 너무 멀어(리스크 과다) maxBaseStopPct를 넘으면 % 기준으로 대체
  const fallbackStop = breakoutLevel * (1 + CONFIG.fallbackStopPct);
  let stopLossLevel = fallbackStop;
  let stopLossBasis = 'percent';

  if (lows && lows.length >= baseLookback) {
    const recentLows = lows.slice(-(baseLookback + 1), -1); // 오늘 제외 베이스 구간 저가
    if (recentLows.length) {
      const baseLow = Math.min(...recentLows);
      const baseLowPct = baseLow / breakoutLevel - 1;
      if (baseLowPct >= CONFIG.maxBaseStopPct) {
        stopLossLevel = baseLow;
        stopLossBasis = 'base_low';
      }
    }
  }

  return { isBreakout, breakoutLevel, stopLossLevel, stopLossBasis };
}

/**
 * 유동성 필터: 20일 평균 거래대금이 기준 이상인지
 */
function passesLiquidity(closes, volumes, market) {
  if (closes.length < 20 || volumes.length < 20) return false;
  const values = closes.slice(-20).map((c, i) => c * volumes.slice(-20)[i]);
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
  const threshold = market === 'KR' ? CONFIG.minTradingValueKR : CONFIG.minTradingValueUS;
  return avgValue >= threshold;
}

/**
 * 종목 하나에 대해 체크리스트 전체를 계산해서 점수화
 * lookback: 신고가/돌파 판단 기준 기간(거래일). 미지정 시 CONFIG 기본값(36주) 사용
 * rsRatingPercentile: 스캔 대상 종목군 내 RS Rating 백분위(0~100). 서버에서 computeRsRatings로
 *   미리 계산해서 넘겨줌. 단일 종목만 보는 백테스트에서는 계산 불가하므로 undefined로 남겨두면
 *   해당 체크리스트 항목 자체가 빠짐(점수 분모가 자동으로 줄어듦).
 */
function evaluateStock({ ticker, name, sector, highs, closes, lows, volumes, indexCloses, indexRegime, sectorAvgReturn, market, lookback, rsRatingPercentile }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const breakout = checkBreakout(highs, closes, lows, effectiveLookback);
  const volRatio = volumeSurgeRatio(volumes);
  const highDistance = distanceFromFiftyTwoWeekHigh(highs, closes, effectiveLookback);
  const liquidityOk = passesLiquidity(closes, volumes, market); // 체크리스트 항목이 아니라 하드 필터 - 미달 종목은 서버에서 결과 목록에서 제외됨
  const trendTemplateOk = checkTrendTemplate(closes); // null이면 데이터 부족 - 아래서 체크리스트에서 제외 처리

  const checklist = {
    marketRegimeOk: indexRegime === 'STRONG_UP' || indexRegime === 'WEAK_UP',
    relativeStrengthOk: highDistance !== null && highDistance >= CONFIG.nearHighThreshold, // 신고가 대비 -20% 이내 근접
    volumeSurgeOk: volRatio !== null && volRatio >= CONFIG.volumeSurgeMultiple,
    breakoutOk: breakout.isBreakout,
    ...(trendTemplateOk !== null ? { trendTemplateOk } : {}), // 미너비니 트렌드 템플릿(이평선 정렬)
    ...(rsRatingPercentile !== undefined && rsRatingPercentile !== null
      ? { rsRatingOk: rsRatingPercentile >= CONFIG.rsRatingThreshold }
      : {}), // RS Rating (스캔 종목군 내 백분위) - 백테스트 등 단일종목 컨텍스트에서는 빠짐
  };

  const passCount = Object.values(checklist).filter(Boolean).length;
  const totalChecks = Object.keys(checklist).length;

  return {
    ticker,
    name,
    sector,
    market,
    indexRegime,
    liquidityOk, // 하드 필터 판정 결과 (서버에서 이 값으로 목록 필터링)
    positionSizeFactor: regimePositionSizeFactor(indexRegime),
    relativeStrength: highDistance, // 필드명은 유지(프론트 호환), 의미는 "N일 신고가 대비 위치"
    volumeSurgeRatio: volRatio,
    breakoutLevel: breakout.breakoutLevel,
    stopLossLevel: breakout.stopLossLevel,
    stopLossBasis: breakout.stopLossBasis, // 'base_low' | 'percent'
    rsRatingPercentile: rsRatingPercentile ?? null,
    lastClose: closes[closes.length - 1],
    checklist,
    score: passCount,
    scoreMax: totalChecks, // 데이터 부족으로 일부 항목이 빠지면 이 값도 같이 줄어듦
    sectorAvgReturn,
  };
}

/**
 * 메뉴에서 선택 가능한 lookback 기간 옵션 (거래일 기준)
 * 서버·프론트가 동일 옵션을 참조하도록 여기서 단일 관리
 */
const LOOKBACK_OPTIONS = {
  '60d': { days: 60, label: '60일' },
  '120d': { days: 120, label: '120일' },
  '36w': { days: 180, label: '36주' },
  '52w': { days: 252, label: '52주' },
};

module.exports = {
  CONFIG,
  LOOKBACK_OPTIONS,
  classifyMarketRegime,
  distanceFromFiftyTwoWeekHigh,
  volumeSurgeRatio,
  checkTrendTemplate,
  computeRsRatings,
  checkBreakout,
  evaluateStock,
};
