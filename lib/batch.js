/**
 * items를 concurrency 만큼씩 나눠서 순차 처리.
 * 크롤링 대상 사이트에 과도한 동시 요청을 보내지 않기 위한 안전장치.
 * 실패한 항목은 건너뛰고 계속 진행 (한 종목 실패가 전체를 멈추지 않도록).
 *
 * onError(선택): 항목 하나가 실패할 때마다 호출됨 (item, err). 반환값 배열만 보면
 * "실패한 종목들이 그냥 조용히 빠진 것"과 "애초에 조건 미달이라 없는 것"을 구분할
 * 수 없어서(=결과가 실제보다 더 깨끗해 보이는 착시), 실패율이 높을 때 호출부가
 * 이걸로 감지해서 결과 자체를 신뢰할 수 없다고 판단하고 에러를 던지게 하기 위함
 * (2026-08-29, 부분실패가 "신호 없음"으로 둔갑하는 걸 막기 위해 추가).
 */
async function runBatched(items, worker, concurrency = 8, onError) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await worker(items[idx], idx);
        if (r !== null && r !== undefined) results.push(r);
      } catch (err) {
        console.warn(`[batch] item ${idx} failed:`, err.message);
        if (onError) onError(items[idx], err);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results;
}

module.exports = { runBatched };
