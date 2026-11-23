#!/usr/bin/env node
// GitHub 프로필 통계 SVG 생성기 (의존성 없음, Node 18+)
// 사용법:
//   GH_TOKEN=... node .github/stats/generate.mjs            # 실제 데이터로 assets/ 에 생성
//   node .github/stats/generate.mjs --mock --out ./preview  # 목 데이터로 미리보기 생성
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const API = "https://api.github.com/graphql";

const args = process.argv.slice(2);
const isMock = args.includes("--mock");
const outIdx = args.indexOf("--out");
const OUT_DIR = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, "assets");


// ---------------------------------------------------------------- GitHub API

async function gql(query, variables = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN 환경변수가 필요해 (read:user + repo + read:org 권한의 PAT)");

  // 5xx 는 일시적인 경우가 많아서 최대 3번까지 백오프하며 재시도
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "profile-stats-generator",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 2_000));
      continue;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL 오류: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
}

const REPO_QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    id
    createdAt
    pullRequests { totalCount }
    issues { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

// ---- 커밋 수: private 레포 포함, 모든 branch 기준 (SHA 중복 제거) ----
// GitHub 기본 집계(totalCommitContributions)는 default branch 커밋만 세기 때문에 직접 센다.

const BRANCH_QUERY = `
query($owner: String!, $name: String!, $authorId: ID!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          ... on Commit {
            history(first: 100, author: { id: $authorId }) {
              pageInfo { hasNextPage endCursor }
              nodes { oid }
            }
          }
        }
      }
    }
  }
}`;

const BRANCH_HISTORY_QUERY = `
query($owner: String!, $name: String!, $branch: String!, $authorId: ID!, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: 100, after: $after, author: { id: $authorId }) {
            pageInfo { hasNextPage endCursor }
            nodes { oid }
          }
        }
      }
    }
  }
}`;

const COMMIT_REPO_QUERY = `
query($login: String!, $affiliations: [RepositoryAffiliation], $after: String) {
  user(login: $login) {
    repositories(ownerAffiliations: $affiliations, isFork: false, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name owner { login } }
    }
  }
}`;

async function countAllBranchCommits(username, authorId, affiliations) {
  // 대상 레포 목록 (private, org 레포 포함)
  const repos = [];
  let after = null;
  do {
    const { user } = await gql(COMMIT_REPO_QUERY, { login: username, affiliations, after });
    repos.push(...user.repositories.nodes);
    const { hasNextPage, endCursor } = user.repositories.pageInfo;
    after = hasNextPage ? endCursor : null;
  } while (after);

  const seen = new Set();

  for (const repo of repos) {
    const base = { owner: repo.owner.login, name: repo.name, authorId };
    let refAfter = null;

    do {
      const { repository } = await gql(BRANCH_QUERY, { ...base, after: refAfter });
      if (!repository) break; // 접근 권한이 없는 레포는 건너뜀
      const { nodes, pageInfo } = repository.refs;

      for (const branch of nodes) {
        const history = branch.target?.history;
        if (!history) continue;
        history.nodes.forEach((n) => seen.add(n.oid));

        // 한 branch 에 내 커밋이 100개를 넘으면 나머지 페이지를 이어서 가져옴
        let cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
        while (cursor) {
          const data = await gql(BRANCH_HISTORY_QUERY, {
            ...base,
            branch: `refs/heads/${branch.name}`,
            after: cursor,
          });
          const h = data.repository?.ref?.target?.history;
          if (!h) break;
          h.nodes.forEach((n) => seen.add(n.oid));
          cursor = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
        }
      }
      refAfter = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (refAfter);
  }
  return seen.size;
}

// 연도별 contributionsCollection 은 최대 1년 범위라서 연 단위로 나눠서 요청
function yearQuery(years) {
  const now = new Date();
  const parts = years.map((y) => {
    const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const to = (end > now ? now : end).toISOString();
    return `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") {
      totalCommitContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }`;
  });
  return `query($login: String!) { user(login: $login) { ${parts.join("\n")} } }`;
}

async function fetchRealData(username, commitAffiliations) {
  // 1) 레포 / PR / 이슈 / 언어
  let after = null;
  let createdAt = null;
  let userId = null;
  let prs = 0;
  let issues = 0;
  let stars = 0;
  const langBytes = new Map();

  do {
    const { user } = await gql(REPO_QUERY, { login: username, after });
    createdAt ??= user.createdAt;
    userId ??= user.id;
    prs = user.pullRequests.totalCount;
    issues = user.issues.totalCount;

    for (const repo of user.repositories.nodes) {
      stars += repo.stargazerCount;
      for (const { size, node } of repo.languages.edges) {
        langBytes.set(node.name, (langBytes.get(node.name) ?? 0) + size);
      }
    }
    const { hasNextPage, endCursor } = user.repositories.pageInfo;
    after = hasNextPage ? endCursor : null;
  } while (after);

  // 2) 연도별 기여 내역
  const firstYear = new Date(createdAt).getUTCFullYear();
  const lastYear = new Date().getUTCFullYear();
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);

  // 커밋은 모든 branch + private 레포 기준으로 직접 집계 (위 연도별 값은 사용하지 않음)
  const commits = await countAllBranchCommits(username, userId, commitAffiliations);
  let contributions = 0;
  const days = [];

  // 요청 하나가 너무 커지지 않게 5년씩 끊어서 요청
  for (let i = 0; i < years.length; i += 5) {
    const chunk = years.slice(i, i + 5);
    const { user } = await gql(yearQuery(chunk), { login: username });
    for (const y of chunk) {
      const c = user[`y${y}`];
      contributions += c.contributionCalendar.totalContributions;
      for (const w of c.contributionCalendar.weeks) {
        for (const d of w.contributionDays) days.push({ date: d.date, count: d.contributionCount });
      }
    }
  }

  return { stars, prs, issues, commits, contributions, langBytes, days, since: createdAt };
}


// 미리보기용 목 데이터. 숫자는 2026-11-23 스크린샷 값, 일별 패턴은 임의 생성
function mockData() {
  const days = [];
  for (let i = 400; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 10, 23) - i * 86_400_000);
    const v = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    days.push({ date: d.toISOString().slice(0, 10), count: i < 5 ? 3 : v < 0.45 ? 0 : Math.round(v * 9) });
  }
  return {
    stars: 6,
    prs: 3,
    issues: 1,
    commits: 294,
    contributions: 1341,
    since: "2021-04-18T00:00:00Z",
    langBytes: new Map([
      ["Python", 33.72],
      ["Rust", 31.52],
      ["TypeScript", 18.17],
      ["Shell", 11.33],
      ["JavaScript", 3.18],
      ["Kotlin", 2.08],
    ]),
    days,
  };
}

// ---------------------------------------------------------------- 계산

function computeStreaks(allDays) {
  const today = new Date().toISOString().slice(0, 10);
  const days = allDays.filter((d) => d.date <= today).sort((a, b) => a.date.localeCompare(b.date));

  let longest = { length: 0, start: null, end: null };
  let run = 0;
  let runStart = null;
  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run > longest.length) longest = { length: run, start: runStart, end: d.date };
    } else run = 0;
  }

  // 오늘 아직 기여가 없으면 어제까지의 streak 를 현재 streak 로 본다
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  const end = i >= 0 ? days[i].date : null;
  let length = 0;
  while (i >= 0 && days[i].count > 0) {
    length++;
    i--;
  }
  const current = { length, start: length ? days[i + 1].date : null, end: length ? end : null };
  return { current, longest };
}

// 최근 52주(일~토 단위) 주간 합계
function weeklyTotals(allDays, weeks = 52) {
  const map = new Map(allDays.map((d) => [d.date, d.count]));
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const lastSunday = new Date(today.getTime() - today.getUTCDay() * 86_400_000);
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = new Date(lastSunday.getTime() - w * 7 * 86_400_000);
    let sum = 0;
    for (let d = 0; d < 7; d++) {
      const key = new Date(start.getTime() + d * 86_400_000).toISOString().slice(0, 10);
      sum += map.get(key) ?? 0;
    }
    out.push({ start, count: sum });
  }
  return out;
}

function languageShares(langBytes, { maxLanguages, excludeLanguages }) {
  const excluded = new Set(excludeLanguages.map((s) => s.toLowerCase()));
  const entries = [...langBytes.entries()]
    .filter(([name]) => !excluded.has(name.toLowerCase()))
    .sort((a, b) => b[1] - a[1]);

  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return [];

  const top = entries.slice(0, maxLanguages);
  const restSum = entries.slice(maxLanguages).reduce((sum, [, v]) => sum + v, 0);
  if (restSum > 0) top.push(["Other", restSum]);

  return top.map(([name, v]) => ({ name, share: (v / total) * 100 }));
}

// ---------------------------------------------------------------- 렌더링 (Lunive Design System)

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Number(n).toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const range = (r) => {
  if (!r.start) return "";
  if (r.start === r.end) return day(r.start);
  const sameMonth = r.start.slice(0, 7) === r.end.slice(0, 7);
  return `${day(r.start)} — ${sameMonth ? Number(r.end.slice(8)) : day(r.end)}`;
};

// Lunive spring 프리셋(stiffness, damping, mass)을 시뮬레이션해서 CSS linear() 곡선으로 굽는다.
// README 의 SVG 는 JS 가 안 돌아서 Motion 을 직접 쓸 수 없기 때문
function spring(k, d, m) {
  const dt = 1 / 240;
  let x = 0;
  let v = 0;
  let t = 0;
  const xs = [0];
  while (t < 3) {
    v += ((-k * (x - 1) - d * v) / m) * dt;
    x += v * dt;
    t += dt;
    xs.push(x);
    if (Math.abs(x - 1) < 0.0005 && Math.abs(v) < 0.01) break;
  }
  const N = 40;
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push(i === N ? 1 : +xs[Math.round((i / N) * (xs.length - 1))].toFixed(4));
  return { ms: Math.round(t * 1000), fn: `linear(${pts.join(", ")})` };
}
const SPRINGS = { medium: spring(280, 25, 1), item: spring(380, 30, 1), smooth: spring(80, 20, 1.2) };
const anim = (name, preset, delayMs) => {
  const s = SPRINGS[preset];
  return `animation:${name} ${s.ms}ms ${s.fn} ${delayMs}ms both`;
};

function baseStyle(t, fontB64) {
  return `<style>
    @font-face{font-family:'Inter Card';src:url(data:font/woff2;base64,${fontB64}) format('woff2');font-weight:100 900}
    text{font-family:'Inter Card','Inter','Pretendard Variable',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-feature-settings:'tnum'}
    .mark{font-size:20px;font-weight:700;letter-spacing:-0.025em;fill:${t.strong}}
    .eyebrow{font-size:12px;font-weight:500;letter-spacing:0.05em;fill:${t.muted}}
    .label{font-size:14px;fill:${t.muted}}
    .value{font-size:14px;font-weight:600;fill:${t.strong}}
    .note{font-size:12px;fill:${t.muted}}
    .micro{font-size:11px;letter-spacing:0.1em;fill:${t.muted}}
    .name{font-size:14px;font-weight:500;fill:${t.strong}}
    .fb{transform-box:fill-box}
    @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
    @keyframes fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
    @media (prefers-reduced-motion:reduce){*{animation:none !important}}
  </style>`;
}

const W = 830;
const X0 = 40;
const X1 = 790;
const COL_GAP = 40;
const COL_W = (X1 - X0 - COL_GAP) / 2;

function header(title, eyebrow) {
  return `<g style="${anim("rise", "medium", 0)}">
    <text x="${X0}" y="53" class="mark">${esc(title)}</text>
    <text x="${X1}" y="51" class="eyebrow" text-anchor="end">${esc(eyebrow.toUpperCase())}</text>
  </g>`;
}

function renderStats(data, streaks, weeks, username, t, fontB64) {
  const sinceYear = new Date(data.since).getUTCFullYear();
  const rows = [
    ["Contributions", num(data.contributions), `since ${sinceYear}`],
    ["Commits", num(data.commits), "all branches"],
    ["Pull requests", num(data.prs), ""],
    ["Stars earned", num(data.stars), ""],
    ["Current streak", `${num(streaks.current.length)} day${streaks.current.length === 1 ? "" : "s"}`, range(streaks.current)],
    ["Longest streak", `${num(streaks.longest.length)} day${streaks.longest.length === 1 ? "" : "s"}`, range(streaks.longest)],
  ];

  const LEDGER_Y = 80;
  const ROW_H = 40;
  const ledger = rows
    .map(([label, value, note], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = X0 + col * (COL_W + COL_GAP);
      const y = LEDGER_Y + row * ROW_H;
      return `<g style="${anim("rise", "item", 80 + i * 40)}">
    <line x1="${x}" y1="${y + ROW_H - 0.5}" x2="${x + COL_W}" y2="${y + ROW_H - 0.5}" stroke="${t.border}"/>
    <text x="${x}" y="${y + 25}" class="label">${esc(label)}</text>
    <text x="${x + COL_W}" y="${y + 25}" text-anchor="end"><tspan class="value">${esc(value)}</tspan>${note ? `<tspan class="note" dx="6">${esc(note)}</tspan>` : ""}</text>
  </g>`;
    })
    .join("\n  ");
  const ledgerTop = `<line x1="${X0}" y1="${LEDGER_Y + 0.5}" x2="${X0 + COL_W}" y2="${LEDGER_Y + 0.5}" stroke="${t.border}"/>
  <line x1="${X0 + COL_W + COL_GAP}" y1="${LEDGER_Y + 0.5}" x2="${X1}" y2="${LEDGER_Y + 0.5}" stroke="${t.border}"/>`;

  // 주간 막대 그래프
  const CHART_TOP = LEDGER_Y + 3 * ROW_H + 28;
  const CHART_H = 72;
  const base = CHART_TOP + CHART_H;
  const GAP = 4;
  const bw = (X1 - X0 - GAP * (weeks.length - 1)) / weeks.length;
  const max = Math.max(1, ...weeks.map((w) => w.count));
  let lastMonth = -1;
  const bars = [];
  const labels = [];
  weeks.forEach((w, i) => {
    const x = X0 + i * (bw + GAP);
    const h = w.count === 0 ? 3 : Math.max(6, Math.round((w.count / max) * CHART_H));
    const r = Math.min(3, bw / 2);
    bars.push(
      `<rect class="fb" x="${x.toFixed(2)}" y="${base - h}" width="${bw.toFixed(2)}" height="${h}" rx="${w.count === 0 ? 1 : r}" fill="${w.count === 0 ? t.rule : t.text}" style="transform-origin:bottom;${anim("grow", "medium", 320 + i * 10)}"/>`,
    );
    const m = w.start.getUTCMonth();
    if (m !== lastMonth && i > 0 && i < weeks.length - 3) labels.push(`<text x="${x.toFixed(2)}" y="${base + 21}" class="micro">${MONTHS[m].toUpperCase()}</text>`);
    lastMonth = m;
  });

  const H = base + 24 + 32;
  const desc = rows.map(([l, v, n]) => `${l} ${v}${n ? ` (${n})` : ""}`).join(", ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">GitHub activity of ${esc(username)}</title>
  <desc id="d">${esc(desc)}. Weekly contributions for the last 52 weeks.</desc>
  ${baseStyle(t, fontB64)}
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="28" fill="${t.bg}" stroke="${t.border}"/>
  ${header(username, "GitHub activity")}
  ${ledgerTop}
  ${ledger}
  <g>
    ${bars.join("\n    ")}
  </g>
  ${labels.join("\n  ")}
</svg>
`;
}

function renderLanguages(shares, t, fontB64) {
  const BAR_Y = 80;
  const LEDGER_Y = BAR_Y + 10 + 20;
  const ROW_H = 40;
  const rows = Math.max(1, Math.ceil(shares.length / 2));
  const H = LEDGER_Y + rows * ROW_H + 32;
  const alpha = [1, 0.74, 0.54, 0.38, 0.26, 0.16, 0.1];
  const shade = (i) => `rgba(${t.ink}, ${alpha[Math.min(i, alpha.length - 1)]})`;
  const max = shares[0]?.share ?? 1;

  // 비율 바: 구간 사이 3px 간격
  const GAP = 3;
  const usable = X1 - X0 - GAP * (shares.length - 1);
  let cursor = X0;
  const segments = shares
    .map((s, i) => {
      const w = Math.max(3, (s.share / 100) * usable);
      const el = `<rect x="${cursor.toFixed(2)}" y="${BAR_Y}" width="${w.toFixed(2)}" height="10" fill="${shade(i)}"/>`;
      cursor += w + GAP;
      return el;
    })
    .join("\n      ");

  const ledger = shares
    .map((s, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = X0 + col * (COL_W + COL_GAP);
      const y = LEDGER_Y + row * ROW_H;
      const trackX = x + 22 + 96 + 12;
      const trackEnd = x + COL_W - 48 - 12;
      const fillW = Math.max(2, ((trackEnd - trackX) * s.share) / max);
      return `<g style="${anim("rise", "item", 240 + i * 40)}">
    <line x1="${x}" y1="${y + ROW_H - 0.5}" x2="${x + COL_W}" y2="${y + ROW_H - 0.5}" stroke="${t.border}"/>
    <rect x="${x}" y="${y + 15}" width="10" height="10" rx="2" fill="${shade(i)}"/>
    <text x="${x + 22}" y="${y + 25}" class="name">${esc(s.name)}</text>
    <rect x="${trackX}" y="${y + 19}" width="${trackEnd - trackX}" height="2" rx="1" fill="${t.rule}"/>
    <rect x="${trackX}" y="${y + 19}" width="${fillW.toFixed(2)}" height="2" rx="1" fill="${t.text}"/>
    <text x="${x + COL_W}" y="${y + 25}" class="value" text-anchor="end">${s.share.toFixed(1)}%</text>
  </g>`;
    })
    .join("\n  ");

  const desc = shares.map((s) => `${s.name} ${s.share.toFixed(1)}%`).join(", ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">Most used languages</title>
  <desc id="d">${esc(desc)}</desc>
  ${baseStyle(t, fontB64)}
  <defs><clipPath id="bar"><rect x="${X0}" y="${BAR_Y}" width="${X1 - X0}" height="10" rx="5"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="28" fill="${t.bg}" stroke="${t.border}"/>
  ${header("Languages", "By code size")}
  <g clip-path="url(#bar)">
    <g class="fb" style="transform-origin:left;${anim("fill", "smooth", 80)}">
      ${segments}
    </g>
  </g>
  <line x1="${X0}" y1="${LEDGER_Y + 0.5}" x2="${X0 + COL_W}" y2="${LEDGER_Y + 0.5}" stroke="${t.border}"/>
  <line x1="${X0 + COL_W + COL_GAP}" y1="${LEDGER_Y + 0.5}" x2="${X1}" y2="${LEDGER_Y + 0.5}" stroke="${t.border}"/>
  ${ledger}
</svg>
`;
}

// ---------------------------------------------------------------- main

async function main() {
  const config = JSON.parse(await readFile(path.join(__dirname, "config.json"), "utf8"));
  const affiliations = config.commitRepoAffiliations ?? ["OWNER", "COLLABORATOR", "ORGANIZATION_MEMBER"];
  const data = isMock ? mockData() : await fetchRealData(config.username, affiliations);
  const fontB64 = (await readFile(path.join(__dirname, "fonts/inter-latin.woff2"))).toString("base64");

  const streaks = computeStreaks(data.days);
  const weeks = weeklyTotals(data.days);
  const shares = languageShares(data.langBytes, config);

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, theme] of Object.entries(config.themes)) {
    await writeFile(path.join(OUT_DIR, `stats-${name}.svg`), renderStats(data, streaks, weeks, config.username, theme, fontB64));
    await writeFile(path.join(OUT_DIR, `languages-${name}.svg`), renderLanguages(shares, theme, fontB64));
  }
  console.log(`생성 완료: ${OUT_DIR}${isMock ? " (mock)" : ""}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
