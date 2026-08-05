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
 * 돌파 여부 판단 - 36주 신고가(전고점) 돌파 기준
 * closes: 종가 배열, lookback(기본 36주=180거래일) 기간의 "당일 제외 최고가"를 오늘 종가가 넘었는지 확인
 * 반환: { isBreakout, breakoutLevel, stopLossLevel }
 */
function checkBreakout(highs, closes, lookback = CONFIG.breakoutLookback) {
  if (closes.length < lookback + 1) return { isBreakout: false, breakoutLevel: null, stopLossLevel: null };
  const priorHighs = highs.slice(-(lookback + 1), -1); // 오늘 제외 lookback일
  const breakoutLevel = Math.max(...priorHighs);
  const todayClose = closes[closes.length - 1];
  const isBreakout = todayClose > breakoutLevel;

  // 손절선: 돌파 저항선(베이스 상단) 대비 일정 % 아래, 혹은 최근 저점 중 더 타이트한 쪽
  // MVP 단계에서는 단순하게 "저항선의 97%" 지점으로 설정 (추후 베이스 하단가 계산으로 고도화 가능)
  const stopLossLevel = breakoutLevel * 0.97;

  return { isBreakout, breakoutLevel, stopLossLevel };
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
 */
function evaluateStock({ ticker, name, sector, highs, closes, volumes, indexCloses, indexRegime, sectorAvgReturn, market, lookback }) {
  const effectiveLookback = lookback || CONFIG.breakoutLookback;
  const breakout = checkBreakout(highs, closes, effectiveLookback);
  const volRatio = volumeSurgeRatio(volumes);
  const highDistance = distanceFromFiftyTwoWeekHigh(highs, closes, effectiveLookback);
  const liquidityOk = passesLiquidity(closes, volumes, market);

  const checklist = {
    marketRegimeOk: indexRegime === 'STRONG_UP' || indexRegime === 'WEAK_UP',
    relativeStrengthOk: highDistance !== null && highDistance >= CONFIG.nearHighThreshold, // 신고가 대비 -20% 이내 근접
    volumeSurgeOk: volRatio !== null && volRatio >= CONFIG.volumeSurgeMultiple,
    breakoutOk: breakout.isBreakout,
    liquidityOk,
  };

  const passCount = Object.values(checklist).filter(Boolean).length;

  // 개별 종목 강도(%): 시장국면을 제외한 종목 고유 조건(신고가근접·거래량·돌파·유동성) 4개 중 통과 비율
  const stockCriteria = [checklist.relativeStrengthOk, checklist.volumeSurgeOk, checklist.breakoutOk, checklist.liquidityOk];
  const stockStrengthPct = Math.round((stockCriteria.filter(Boolean).length / stockCriteria.length) * 100);

  return {
    ticker,
    name,
    sector,
    market,
    indexRegime,
    positionSizeFactor: regimePositionSizeFactor(indexRegime),
    stockStrengthPct, // 개별 종목 강도 (0~100%) - 시장 국면과 무관하게 종목 자체 조건 충족도
    relativeStrength: highDistance, // 필드명은 유지(프론트 호환), 의미는 "N일 신고가 대비 위치"
    volumeSurgeRatio: volRatio,
    breakoutLevel: breakout.breakoutLevel,
    stopLossLevel: breakout.stopLossLevel,
    lastClose: closes[closes.length - 1],
    checklist,
    score: passCount, // 0~5
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
  sma,
  classifyMarketRegime,
  regimePositionSizeFactor,
  distanceFromFiftyTwoWeekHigh,
  volumeSurgeRatio,
  checkBreakout,
  passesLiquidity,
  evaluateStock,
};
