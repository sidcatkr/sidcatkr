#!/usr/bin/env node
// README 용 Snake 미리보기 카드 생성기 (의존성 없음)
// README 안에서는 JS 가 안 돌아서, jmin.me 의 Snake 화면을 CSS 애니메이션 SVG 로 옮겼다.
//  - 제목 글자 순차 등장 + 뱀 머리 로고(눈 깜빡임)
//  - SCORE 표시, 점 격자 보드, 칸 단위로 움직이는 뱀
//  - 범례와 "시작하기" 버튼(버튼 속 뱀, 눈 깜빡임)
// 사용법: node .github/stats/snake-card.mjs [--out ./assets]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const OUT_DIR = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.resolve(__dirname, '../../assets')

// jmin.me globals.css 와 같은 색
const THEMES = {
  light: { bg: '#ffffff', fg: '#171717', border: '#e2dccf' },
  dark: { bg: '#0a0a0a', fg: '#ededed', border: '#242321' },
}

// ---------------------------------------------------------------- 치수

const W = 830
const PAD = 24
const CELL = 30
const COLS = 25
const ROWS = 7
const LENGTH = 9
const STEP = 0.2 // 한 칸 이동 시간(초). 원본 시작 속도 = 초당 5칸

const TITLE_SIZE = 40
const TITLE_BASE = 64
const BOARD_Y = 84
const BOARD_PAD = 16
const BOARD_W = COLS * CELL + BOARD_PAD * 2
const BOARD_H = ROWS * CELL + BOARD_PAD * 2
const TOOL_Y = BOARD_Y + BOARD_H + 16 // 버튼 윗변
const H = TOOL_Y + 48 + PAD

// Geist(500) 의 S n a k e 글자 폭(단위 1/1000 em). fonts/geist-snake.woff2 에서 측정한 값
const ADVANCE = { S: 654, n: 591, a: 565, k: 609, e: 576 }

// ---------------------------------------------------------------- 유틸

function mix(a, b, pctA) {
  // CSS color-mix(in srgb, a pctA%, b) 와 같은 계산
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  const t = pctA / 100
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')
}

// Motion 의 { type: 'spring', visualDuration: 0.5, bounce: 0.18 } 을 시뮬레이션해서 CSS linear() 로 굽는다
function springCurve(visualDuration, bounce) {
  const k = ((2 * Math.PI) / (visualDuration * 1.2)) ** 2
  const d = 2 * (1 - bounce) * Math.sqrt(k)
  const dt = 1 / 240
  let x = 0
  let v = 0
  let t = 0
  const xs = [0]
  while (t < 3) {
    v += (-k * (x - 1) - d * v) * dt
    x += v * dt
    t += dt
    xs.push(x)
    if (Math.abs(x - 1) < 0.0005 && Math.abs(v) < 0.01) break
  }
  const N = 40
  const pts = []
  for (let i = 0; i <= N; i++) pts.push(i === N ? 1 : +xs[Math.round((i / N) * (xs.length - 1))].toFixed(4))
  return { ms: Math.round(t * 1000), fn: `linear(${pts.join(', ')})` }
}

function buildRoute(corners) {
  const cells = []
  for (let i = 0; i < corners.length; i++) {
    const [x0, y0] = corners[i]
    const [x1, y1] = corners[(i + 1) % corners.length]
    const dx = Math.sign(x1 - x0)
    const dy = Math.sign(y1 - y0)
    let [x, y] = [x0, y0]
    while (x !== x1 || y !== y1) {
      cells.push([x, y])
      x += dx
      y += dy
    }
  }
  return cells
}

// ---------------------------------------------------------------- 경로

const route = buildRoute([
  [2, 1], [22, 1], [22, 5], [15, 5], [15, 3], [10, 3], [10, 5], [2, 5],
])
const L = route.length
const dirs = route.map(([x0, y0], i) => {
  const [x1, y1] = route[(i + 1) % L]
  return [x1 - x0, y1 - y0]
})

const cx = (x) => PAD + BOARD_PAD + x * CELL + CELL / 2
const cy = (y) => BOARD_Y + BOARD_PAD + y * CELL + CELL / 2
const pct = (i) => ((i / L) * 100).toFixed(4)

// ---------------------------------------------------------------- 렌더

function render(t, fonts) {
  const surface = mix(t.fg, t.bg, 3)
  const grid = mix(t.fg, t.bg, 13)
  const muted = mix(t.fg, t.bg, 70)
  const statsMuted = mix(t.fg, t.bg, 60)
  const spring = springCurve(0.5, 0.18)
  const enter = (name, delay) => `animation:${name} ${spring.ms}ms ${spring.fn} ${delay}s both`
  const total = (L * STEP).toFixed(2)

  // 뱀 몸통: 원본처럼 칸 단위로 이동한다(steps). 모든 마디가 같은 keyframes, 지연만 다르다.
  const move = route.map(([x, y], i) => `${pct(i)}%{transform:translate(${cx(x)}px,${cy(y)}px)}`).join('')
  // 눈: 머리 중심 + 진행 방향 3px, 좌우 3px (원본 계산식 그대로)
  const eye = (side) =>
    route
      .map(([x, y], i) => {
        const [dx, dy] = dirs[(i - 1 + L) % L]
        return `${pct(i)}%{transform:translate(${cx(x) + dx * 3 - dy * side * 3}px,${cy(y) + dy * 3 + dx * side * 3}px)}`
      })
      .join('')

  const segments = Array.from({ length: LENGTH }, (_, i) => {
    const progress = i / (LENGTH - 1)
    const r = (11.5 - progress * 6).toFixed(2)
    const fill = mix(t.fg, surface, 100 - progress * 55)
    const [x, y] = route[(L - i) % L]
    const delay = (-((L - i) % L) * STEP).toFixed(2)
    return `<circle class="seg" r="${r}" fill="${fill}" transform="translate(${cx(x)} ${cy(y)})" style="animation-delay:${delay}s"/>`
  })
    .reverse()
    .join('\n    ')

  // 제목 글자 위치 (letter-spacing -0.065em 포함)
  const ls = -0.065 * TITLE_SIZE
  let x = PAD
  const letters = [...'Snake']
    .map((ch, i) => {
      const el = `<text x="${x.toFixed(2)}" y="${TITLE_BASE}" class="title" style="${enter('rise', i * 0.055)}">${ch}</text>`
      x += (ADVANCE[ch] / 1000) * TITLE_SIZE + ls
      return el
    })
    .join('\n  ')

  // 제목 옆 뱀 머리: .24em 정사각형, 왼쪽 여백 .1em, 기준선에 붙는다
  const headSize = 0.24 * TITLE_SIZE
  const headX = x + 0.1 * TITLE_SIZE
  const headY = TITLE_BASE - headSize
  const headScale = headSize / 14

  const food = [18, 3]
  const poison = [6, 3]

  // 시작하기 버튼 (오른쪽 정렬)
  const btnH = 48
  const btnW = 150
  const btnX = W - PAD - btnW
  const btnY = TOOL_Y
  const snakeX = btnX + btnW - 24 - 32
  const snakeY = btnY + (btnH - 32) / 2

  // 원본 SnakeHead: 몸 원 + 깜빡이는 두 눈
  const snakeHead = (eyeColor) => `<circle cx="16" r="6.2"/>
      <ellipse class="blink" cx="18" cy="-1.9" rx="0.9" ry="0.9" fill="${eyeColor}"/>
      <ellipse class="blink" cx="18" cy="1.9" rx="0.9" ry="0.9" fill="${eyeColor}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">Snake</title>
  <desc id="d">jmin.me 의 스네이크 게임 미리보기. 선택하면 플레이 페이지로 이동합니다.</desc>
  <style>
    @font-face{font-family:'Geist Snake';src:url(data:font/woff2;base64,${fonts.sans}) format('woff2');font-weight:100 900}
    @font-face{font-family:'Geist Mono Score';src:url(data:font/woff2;base64,${fonts.mono}) format('woff2');font-weight:100 900}
    text{font-family:'Geist Variable',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Segoe UI',sans-serif}
    .title{font-family:'Geist Snake','Geist Variable',-apple-system,sans-serif;font-size:${TITLE_SIZE}px;font-weight:500;fill:${t.fg}}
    .mono{font-family:'Geist Mono Score','Geist Mono Variable',ui-monospace,SFMono-Regular,Menlo,monospace}
    .seg{animation:route ${total}s steps(1,end) infinite}
    .eyeL{animation:eyeL ${total}s steps(1,end) infinite}
    .eyeR{animation:eyeR ${total}s steps(1,end) infinite}
    .blink{transform-box:fill-box;transform-origin:center;animation:blink 4.6s ease-in-out infinite}
    .pop{transform-box:fill-box;transform-origin:center}
    @keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
    @keyframes riseScale{from{opacity:0;transform:translateY(24px) scale(.75)}to{opacity:1;transform:none}}
    @keyframes slideIn{from{opacity:0;transform:translate(-24px,24px)}to{opacity:1;transform:none}}
    @keyframes route{${move}}
    @keyframes eyeL{${eye(-1)}}
    @keyframes eyeR{${eye(1)}}
    @keyframes blink{0%,67.3%,73.6%,100%{transform:scaleX(1)}70.4%{transform:scaleX(.1)}}
    @media (prefers-reduced-motion:reduce){*{animation:none !important}}
  </style>

  <rect width="${W}" height="${H}" fill="${t.bg}"/>

  ${letters}
  <g class="pop" style="${enter('riseScale', 0.275)}">
    <g transform="translate(${headX.toFixed(2)} ${headY.toFixed(2)}) scale(${headScale.toFixed(4)}) translate(-9 7)" fill="${t.fg}">
      <g transform="rotate(-45 16 0)">
      ${snakeHead(t.bg)}
      </g>
    </g>
  </g>

  <text x="${W - PAD - 33.6 - 10}" y="${TITLE_BASE}" class="mono" text-anchor="end" style="font-size:10px;fill:${statsMuted}">SCORE</text>
  <text x="${W - PAD}" y="${TITLE_BASE}" class="mono" text-anchor="end" style="font-size:28px;fill:${t.fg};${enter('rise', 0.12)}">00</text>

  <defs><pattern id="dots" x="${PAD + BOARD_PAD}" y="${BOARD_Y + BOARD_PAD}" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="1.5" fill="${grid}"/></pattern></defs>
  <rect x="${PAD + 0.5}" y="${BOARD_Y + 0.5}" width="${BOARD_W - 1}" height="${BOARD_H - 1}" rx="20" fill="${surface}" stroke="${t.border}"/>
  <rect x="${PAD + BOARD_PAD}" y="${BOARD_Y + BOARD_PAD}" width="${COLS * CELL}" height="${ROWS * CELL}" fill="url(#dots)"/>
  <circle cx="${cx(food[0])}" cy="${cy(food[1])}" r="12.5" fill="${t.fg}"/>
  <circle cx="${cx(poison[0])}" cy="${cy(poison[1])}" r="12.2" fill="${t.fg}"/>
  <circle cx="${cx(poison[0])}" cy="${cy(poison[1])}" r="1.6" fill="${surface}" opacity="0.3"/>
  <g>
    ${segments}
    <circle class="eyeL" r="1.3" fill="${surface}" transform="translate(${cx(route[0][0])} ${cy(route[0][1]) - 3})"/>
    <circle class="eyeR" r="1.3" fill="${surface}" transform="translate(${cx(route[0][0])} ${cy(route[0][1]) + 3})"/>
  </g>

  <g style="font-size:12px">
    <circle cx="${PAD + 6}" cy="${TOOL_Y + 24}" r="6" fill="${t.fg}"/>
    <text x="${PAD + 20}" y="${TOOL_Y + 28}" style="fill:${t.fg}">먹으면 성장</text>
    <circle cx="${PAD + 112}" cy="${TOOL_Y + 24}" r="6" fill="${t.fg}"/>
    <circle cx="${PAD + 112}" cy="${TOOL_Y + 24}" r="0.75" fill="${surface}" opacity="0.3"/>
    <text x="${PAD + 126}" y="${TOOL_Y + 28}" style="fill:${t.fg}">닿으면 게임 오버</text>
    <text x="${PAD + 240}" y="${TOOL_Y + 28}" style="fill:${muted}">방향키 / WASD · 스와이프로 이동</text>
  </g>

  <g style="${enter('rise', 0.48)}">
    <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="24" fill="${t.fg}"/>
    <text x="${snakeX - 10}" y="${btnY + 29}" text-anchor="end" style="font-size:14px;fill:${t.bg}">시작하기</text>
    <g style="${enter('slideIn', 0.48)}">
      <g transform="translate(${snakeX} ${snakeY}) scale(0.8) translate(20 20) rotate(-45)" fill="${t.bg}">
        <circle cx="-16" r="2.2" opacity="0.45"/>
        <circle cx="-8" r="3.2" opacity="0.6"/>
        <circle r="4.2" opacity="0.75"/>
        <circle cx="8" r="5.2" opacity="0.9"/>
        ${snakeHead(t.fg)}
      </g>
    </g>
  </g>
</svg>
`
}

// ---------------------------------------------------------------- main

const fonts = {
  sans: (await readFile(path.join(__dirname, 'fonts/geist-snake.woff2'))).toString('base64'),
  mono: (await readFile(path.join(__dirname, 'fonts/geist-mono-score.woff2'))).toString('base64'),
}
await mkdir(OUT_DIR, { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(path.join(OUT_DIR, `snake-${name}.svg`), render(theme, fonts))
}
console.log(`생성 완료: ${OUT_DIR}`)
