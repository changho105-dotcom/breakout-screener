// ============================================================
// paper_trade/daily_update.js 실행 후 변경된 state.json / log.md를
// GitHub에 반영하는 스크립트.
//
// 2026-08-28: 처음엔 git CLI(add/commit/push)로 구현했으나, Railway Cron Job의
// 실행 컨테이너에는 git 바이너리가 없어서("/bin/sh: 1: git: not found") 매번
// 크래시났음. git 설치 여부에 의존하지 않도록 GitHub REST API(Contents API)로
// 직접 파일을 읽고/커밋하는 방식으로 교체 - 어떤 런타임 이미지에서도 동작함.
//
// 필요 환경변수:
//   GITHUB_TOKEN - 이 저장소(contents: read/write)에만 권한을 준
//                  fine-grained PAT. Railway 대시보드의 Variables에서
//                  직접 설정할 것 (절대 코드/로그에 노출 금지).
//
// 사용법: node paper_trade/daily_update.js && node paper_trade/commit_and_push.js
// ============================================================

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const REPO = 'changho105-dotcom/breakout-screener';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_TOKEN;
const FILES = ['paper_trade/state.json', 'paper_trade/log.md'];

function maskToken(str) {
  if (!TOKEN || !str) return str;
  return str.split(TOKEN).join('***');
}

async function githubApi(urlPath, opts = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${urlPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'breakout-screener-paper-trade-bot',
      ...(opts.headers || {}),
    },
  });
}

/**
 * 파일 하나를 GitHub API로 조회 -> 로컬 내용과 다르면 커밋.
 * 로컬과 원격 내용이 같으면(예: 이미 오늘 처리 완료돼서 daily_update.js가
 * 아무것도 안 바꾼 날) 조용히 건너뜀 - 빈 커밋을 만들지 않음.
 */
async function pushFile(relPath, dateStr) {
  const localPath = path.join(__dirname, '..', relPath);
  if (!fs.existsSync(localPath)) {
    console.log(`[commit_and_push] ${relPath} 로컬에 없음, 스킵`);
    return;
  }
  const localB64 = fs.readFileSync(localPath).toString('base64');

  const getRes = await githubApi(`/contents/${relPath}?ref=${BRANCH}`);
  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`GitHub 파일 조회 실패 (${relPath}): 상태코드 ${getRes.status} - ${body.slice(0, 200)}`);
  }
  const meta = await getRes.json();
  const remoteB64 = (meta.content || '').replace(/\n/g, '');
  if (remoteB64 === localB64) {
    console.log(`[commit_and_push] ${relPath} 변경사항 없음, 커밋 생략`);
    return;
  }

  const putRes = await githubApi(`/contents/${relPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore: paper trade auto update - ${dateStr} (Railway cron)`,
      content: localB64,
      sha: meta.sha,
      branch: BRANCH,
    }),
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`GitHub 파일 업데이트 실패 (${relPath}): 상태코드 ${putRes.status} - ${body.slice(0, 200)}`);
  }
  console.log(`[commit_and_push] ${relPath} 커밋 완료`);
}

async function main() {
  if (!TOKEN) {
    console.error('[commit_and_push] GITHUB_TOKEN 환경변수가 없습니다 - 커밋을 건너뜁니다.');
    return; // daily_update.js 결과 자체는 유효하므로 실패시키지 않음
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  for (const relPath of FILES) {
    await pushFile(relPath, dateStr);
  }
}

main().catch((err) => {
  console.error('[commit_and_push] 실패:', maskToken(err.message));
  process.exit(1);
});
