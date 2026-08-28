// ============================================================
// paper_trade/daily_update.js 실행 후 변경된 state.json / log.md를
// GitHub에 커밋·푸시하는 스크립트. Railway Cron Job처럼 매번 컨테이너가
// 새로 떠서(=파일시스템이 휘발성) 로컬 디스크에 상태를 남길 수 없는
// 실행환경을 위한 것 - GitHub 저장소 자체를 영구 저장소로 사용한다.
//
// 필요 환경변수:
//   GITHUB_TOKEN - 이 저장소(contents: read/write)에만 권한을 준
//                  fine-grained PAT. Railway 대시보드의 Variables에서
//                  직접 설정할 것 (절대 코드/로그에 노출 금지).
//
// 사용법: node paper_trade/daily_update.js && node paper_trade/commit_and_push.js
// ============================================================

const { execSync } = require('child_process');

const REPO = 'changho105-dotcom/breakout-screener';
const TOKEN = process.env.GITHUB_TOKEN;

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function main() {
  if (!TOKEN) {
    console.error('[commit_and_push] GITHUB_TOKEN 환경변수가 없습니다 - 커밋/푸시를 건너뜁니다.');
    process.exit(0); // 실패시켜서 daily_update 결과 자체를 무효화하지 않음
  }

  // 변경사항 없으면 조용히 종료 (예: 주말 스킵으로 아무 것도 안 바뀐 경우)
  const status = run('git status --porcelain -- paper_trade/state.json paper_trade/log.md');
  if (!status.trim()) {
    console.log('[commit_and_push] 변경사항 없음, 커밋 생략');
    return;
  }

  run('git config user.email "paper-trade-bot@breakout-screener.local"');
  run('git config user.name "paper-trade-bot"');
  run('git add paper_trade/state.json paper_trade/log.md');

  const dateStr = new Date().toISOString().slice(0, 10);
  run(`git commit -m "chore: paper trade auto update - ${dateStr} (Railway cron)"`);

  // 토큰은 remote URL에만 잠깐 주입하고 절대 stdout/stderr에 찍지 않음
  const remoteUrl = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
  run(`git push ${remoteUrl} HEAD:main`, { stdio: ['ignore', 'ignore', 'ignore'] });
  console.log('[commit_and_push] 완료: state.json/log.md 커밋 및 푸시');
}

try {
  main();
} catch (err) {
  // 토큰이 로그에 노출되지 않도록 에러 메시지에서 토큰 문자열을 마스킹
  const msg = TOKEN ? (err.message || '').split(TOKEN).join('***') : err.message;
  console.error('[commit_and_push] 실패:', msg);
  process.exit(1);
}
