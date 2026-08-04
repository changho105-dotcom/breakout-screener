/**
 * items를 concurrency 만큼씩 나눠서 순차 처리.
 * 크롤링 대상 사이트에 과도한 동시 요청을 보내지 않기 위한 안전장치.
 * 실패한 항목은 건너뛰고 계속 진행 (한 종목 실패가 전체를 멈추지 않도록).
 */
async function runBatched(items, worker, concurrency = 8) {
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
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results;
}

module.exports = { runBatched };
