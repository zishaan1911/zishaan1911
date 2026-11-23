// Generates assets/stats-dark.svg and assets/stats-light.svg from live GitHub data.
// Runs in GitHub Actions (see .github/workflows/stats-card.yml). No dependencies: Node 20+.
//
// Env:
//   GH_TOKEN          token for the GraphQL API (GITHUB_TOKEN works; a PAT with
//                     read:user + repo also counts private contributions)
//   GH_USER           GitHub login (defaults to the repo owner)
//   WAKATIME_API_KEY  optional; if set, "hours coded" comes from WakaTime instead
//                     of being estimated from commit timestamps

import { writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const USER = process.env.GH_USER || (process.env.GITHUB_REPOSITORY || "").split("/")[0];
const WAKA = process.env.WAKATIME_API_KEY;
const OUT = process.env.OUT_DIR || "assets";
if (!TOKEN || !USER) throw new Error("GH_TOKEN and GH_USER are required");

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-stats-card" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.errors) return body.data;
    if (attempt >= 3) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors || body)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// ---------- data ----------

async function profile() {
  const d = await gql(
    `query($login: String!) {
      user(login: $login) {
        id name login createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        contributionsCollection { totalCommitContributions restrictedContributionsCount totalPullRequestReviewContributions }
      }
    }`,
    { login: USER },
  );
  return d.user;
}

async function ownedRepos() {
  const repos = [];
  let after = null;
  do {
    const d = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              nameWithOwner stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
            }
          }
        }
      }`,
      { login: USER, after },
    );
    const page = d.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function contributedRepos() {
  const d = await gql(
    `query($login: String!) {
      user(login: $login) {
        repositoriesContributedTo(first: 100, includeUserRepositories: false, contributionTypes: [COMMIT]) {
          nodes { nameWithOwner }
        }
      }
    }`,
    { login: USER },
  );
  return d.user.repositoriesContributedTo.nodes;
}

// Contribution calendar for every year since the account was created.
async function calendar(createdAt) {
  const days = new Map();
  let total = 0;
  const start = new Date(createdAt);
  const now = new Date();
  for (let y = start.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Math.max(Date.UTC(y, 0, 1), start.getTime()));
    const to = new Date(Math.min(Date.UTC(y, 11, 31, 23, 59, 59), now.getTime()));
    const d = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login: USER, from: from.toISOString(), to: to.toISOString() },
    );
    const cal = d.user.contributionsCollection.contributionCalendar;
    total += cal.totalContributions;
    for (const w of cal.weeks) for (const day of w.contributionDays) days.set(day.date, day.contributionCount);
  }
  return { total, days: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

// Timestamps of every commit the user authored on the default branch of the given repos.
async function commitTimes(userId, repoNames) {
  const times = [];
  for (const full of repoNames) {
    const [owner, name] = full.split("/");
    let after = null;
    do {
      let d;
      try {
        d = await gql(
          `query($owner: String!, $name: String!, $author: ID!, $after: String) {
            repository(owner: $owner, name: $name) {
              defaultBranchRef { target { ... on Commit {
                history(first: 100, after: $after, author: { id: $author }) {
                  pageInfo { hasNextPage endCursor }
                  nodes { authoredDate }
                }
              } } }
            }
          }`,
          { owner, name, author: userId, after },
        );
      } catch {
        break; // repo not readable with this token; skip it
      }
      const h = d.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      times.push(...h.nodes.map((n) => Date.parse(n.authoredDate)));
      after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
    } while (after);
  }
  return times.sort((a, b) => a - b);
}

// Session-based estimate (same idea as git-hours): commits less than 2h apart belong to
// one session and the gap counts as coding time; each new session adds 30 min of lead-in.
function estimateHours(times) {
  const MAX_GAP = 2 * 3600e3;
  const FIRST = 0.5 * 3600e3;
  let ms = 0;
  for (let i = 0; i < times.length; i++) {
    const gap = i ? times[i] - times[i - 1] : Infinity;
    ms += gap < MAX_GAP ? gap : FIRST;
  }
  return ms / 3600e3;
}

async function wakatimeHours() {
  const res = await fetch("https://wakatime.com/api/v1/users/current/all_time_since_today", {
    headers: { Authorization: `Basic ${Buffer.from(WAKA).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`WakaTime ${res.status}`);
  const j = await res.json();
  return j.data.total_seconds / 3600;
}

function streaks(days) {
  // days: [[YYYY-MM-DD, count]] ascending. Today may still be empty without breaking the streak.
  let longest = 0, run = 0, longestEnd = null;
  for (const [date, c] of days) {
    run = c > 0 ? run + 1 : 0;
    if (run > longest) { longest = run; longestEnd = date; }
  }
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i][1] === 0) i--; // today not over yet
  for (; i >= 0 && days[i][1] > 0; i--) current++;
  return { current, longest };
}

// Percentile rank: the published github-readme-stats model (MIT). Each metric is mapped
// through a CDF around a typical-user median, weighted, and the remainder is "top X%".
function rank({ commits, prs, issues, reviews, stars, followers }) {
  const exp = (x) => 1 - 2 ** -x;
  const logn = (x) => x / (1 + x);
  const w = { c: 2, p: 3, i: 1, r: 1, s: 4, f: 1 };
  const total = Object.values(w).reduce((a, b) => a + b);
  const score =
    w.c * exp(commits / 250) + w.p * exp(prs / 50) + w.i * exp(issues / 25) +
    w.r * exp(reviews / 2) + w.s * logn(stars / 50) + w.f * logn(followers / 10);
  const percentile = (1 - score / total) * 100;
  const levels = [[1, "S"], [12.5, "A+"], [25, "A"], [37.5, "A-"], [50, "B+"], [62.5, "B"], [75, "B-"], [87.5, "C+"], [100, "C"]];
  return { percentile, level: levels.find(([t]) => percentile <= t)[1] };
}

// ---------- render ----------

const THEMES = {
  dark: { bg: "#0b0f17", grid: "#1d2433", border: "#1f2735", text: "#f2f5fb", muted: "#7d8aa6", accent: "#ffb347", accent2: "#ffd27a", track: "#1a2130", cell0: "#151b27", ramp: ["#4a2e12", "#8a4d14", "#d9781c", "#ffb347"] },
  light: { bg: "#ffffff", grid: "#eef1f6", border: "#d8dee8", text: "#111827", muted: "#5b6578", accent: "#d9620b", accent2: "#b4530a", track: "#edf0f5", cell0: "#eef1f6", ramp: ["#fde3c2", "#f9b56b", "#ec8a2c", "#c25a07"] },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : Math.round(n).toLocaleString("en-US"));

function render(s, t) {
  const W = 840, H = 360;
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const sans = "ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";

  // rank ring
  const R = 46, C = 2 * Math.PI * R;
  const filled = Math.max(0.02, Math.min(1, 1 - s.rank.percentile / 100));
  const ring = `
    <g transform="translate(108 150)">
      <circle r="${R}" fill="none" stroke="${t.track}" stroke-width="8"/>
      <circle r="${R}" fill="none" stroke="${t.accent}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${(C * filled).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90)" class="ring"/>
      <text y="10" text-anchor="middle" font-family="${sans}" font-size="30" font-weight="700" fill="${t.text}">${s.rank.level}</text>
      <text y="${R + 32}" text-anchor="middle" font-family="${mono}" font-size="13" fill="${t.accent2}">top ${s.rank.percentile < 1 ? s.rank.percentile.toFixed(1) : Math.round(s.rank.percentile)}%</text>
      <text y="${R + 50}" text-anchor="middle" font-family="${mono}" font-size="11" fill="${t.muted}">percentile</text>
    </g>`;

  // stat grid: 3 columns x 3 rows
  const items = [
    ["contributions", fmt(s.totalContributions), "all time"],
    ["current streak", `${s.streak.current}d`, s.streak.current ? "keep going" : "start today"],
    ["longest streak", `${s.streak.longest}d`, "best run"],
    ["hours coded", fmt(s.hours), s.hoursSource],
    ["commits", fmt(s.commitsYear), "past year"],
    ["stars earned", fmt(s.stars), `${s.repos} repos`],
    ["pull requests", fmt(s.prs), "opened"],
    ["issues", fmt(s.issues), "opened"],
    ["followers", fmt(s.followers), "on GitHub"],
  ];
  const grid = items
    .map(([label, value, sub], i) => {
      const x = 230 + (i % 3) * 200, y = 78 + Math.floor(i / 3) * 62;
      return `<g transform="translate(${x} ${y})" class="fade" style="animation-delay:${(i * 60)}ms">
        <text font-family="${mono}" font-size="11" fill="${t.muted}">${esc(label)}</text>
        <text y="27" font-family="${sans}" font-size="24" font-weight="700" fill="${t.text}">${esc(value)}</text>
        <text x="${[...String(value)].reduce((w, ch) => w + (/[,.]/.test(ch) ? 7 : 15), 0) + 8}" y="27" font-family="${mono}" font-size="10.5" fill="${t.muted}">${esc(sub)}</text>
      </g>`;
    })
    .join("");

  // last 52 weeks heat strip (one column per week, weekly totals)
  const recent = s.days.slice(-364);
  const weeks = [];
  for (let i = 0; i < recent.length; i += 7) weeks.push(recent.slice(i, i + 7).reduce((a, [, c]) => a + c, 0));
  const maxW = Math.max(1, ...weeks);
  const gap = 3, sx = 40, sy = 284;
  const cw = (760 + gap) / weeks.length - gap;
  const strip = weeks
    .map((v, i) => {
      const lvl = v === 0 ? -1 : Math.min(3, Math.floor((v / maxW) * 4));
      return `<rect x="${(sx + i * (cw + gap)).toFixed(1)}" y="${sy}" width="${cw.toFixed(1)}" height="22" rx="2.5" fill="${lvl < 0 ? t.cell0 : t.ramp[lvl]}"/>`;
    })
    .join("");

  // top languages bar
  const langTotal = s.langs.reduce((a, l) => a + l.size, 0) || 1;
  let lx = 40;
  const bar = s.langs
    .map((l) => {
      const w = Math.max(2, (l.size / langTotal) * 760);
      const r = `<rect x="${lx.toFixed(1)}" y="322" width="${w.toFixed(1)}" height="6" fill="${l.color || t.muted}"/>`;
      lx += w;
      return r;
    })
    .join("");
  let tx = 40;
  const legend = s.langs
    .map((l) => {
      const label = `${l.name} ${((l.size / langTotal) * 100).toFixed(0)}%`;
      const g = `<circle cx="${tx + 4}" cy="343" r="4" fill="${l.color || t.muted}"/><text x="${tx + 13}" y="347" font-family="${mono}" font-size="11" fill="${t.muted}">${esc(label)}</text>`;
      tx += label.length * 6.8 + 30;
      return g;
    })
    .join("");

  const updated = new Date().toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 10}" viewBox="0 0 ${W} ${H + 10}" role="img" aria-label="${esc(USER)} GitHub stats: ${s.totalContributions} contributions, ${s.streak.current} day streak, top ${Math.round(s.rank.percentile)}%">
  <defs>
    <pattern id="g" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern>
    <clipPath id="bar"><rect x="40" y="322" width="760" height="6" rx="3"/></clipPath>
    <style>
      .fade { opacity: 0; animation: fade .5s ease-out forwards; }
      .ring { animation: ring 1.2s ease-out both; }
      @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
      @keyframes ring { from { stroke-dasharray: 0 ${C.toFixed(1)}; } }
      @media (prefers-reduced-motion: reduce) { .fade, .ring { animation: none; opacity: 1; } }
    </style>
  </defs>
  <rect x=".5" y=".5" width="${W - 1}" height="${H + 9}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
  <rect x=".5" y=".5" width="${W - 1}" height="${H + 9}" rx="14" fill="url(#g)" opacity=".5"/>
  <text x="40" y="44" font-family="${mono}" font-size="14" fill="${t.muted}">~/${esc(USER)} $ <tspan fill="${t.text}">gh stats</tspan></text>
  <text x="${W - 40}" y="44" text-anchor="end" font-family="${mono}" font-size="11" fill="${t.muted}">updated ${updated}</text>
  ${ring}
  ${grid}
  <text x="40" y="274" font-family="${mono}" font-size="11" fill="${t.muted}">last 52 weeks</text>
  <text x="${W - 40}" y="274" text-anchor="end" font-family="${mono}" font-size="11" fill="${t.muted}">${fmt(recent.reduce((a, [, c]) => a + c, 0))} contributions</text>
  ${strip}
  <g clip-path="url(#bar)">${bar}</g>
  ${legend}
</svg>
`;
}

// ---------- main ----------

const user = await profile();
const [repos, contributed, cal] = await Promise.all([ownedRepos(), contributedRepos(), calendar(user.createdAt)]);

const langMap = new Map();
for (const r of repos)
  for (const e of r.languages.edges) {
    const cur = langMap.get(e.node.name) || { name: e.node.name, color: e.node.color, size: 0 };
    cur.size += e.size;
    langMap.set(e.node.name, cur);
  }
const langs = [...langMap.values()].sort((a, b) => b.size - a.size).slice(0, 6);

let hours, hoursSource;
if (WAKA) {
  try { hours = await wakatimeHours(); hoursSource = "wakatime"; } catch (e) { console.warn(String(e)); }
}
if (hours === undefined) {
  const names = [...new Set([...repos.map((r) => r.nameWithOwner), ...contributed.map((r) => r.nameWithOwner)])];
  hours = estimateHours(await commitTimes(user.id, names));
  hoursSource = "est. from commits";
}

const cc = user.contributionsCollection;
const stats = {
  year: new Date().getUTCFullYear(),
  totalContributions: cal.total,
  days: cal.days,
  streak: streaks(cal.days),
  hours,
  hoursSource,
  commitsYear: cc.totalCommitContributions + cc.restrictedContributionsCount,
  stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
  repos: repos.length,
  prs: user.pullRequests.totalCount,
  issues: user.issues.totalCount,
  followers: user.followers.totalCount,
  langs,
};
stats.rank = rank({
  commits: stats.commitsYear, prs: stats.prs, issues: stats.issues,
  reviews: cc.totalPullRequestReviewContributions, stars: stats.stars, followers: stats.followers,
});

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats-dark.svg`, render(stats, THEMES.dark));
await writeFile(`${OUT}/stats-light.svg`, render(stats, THEMES.light));
const { days, langs: _l, ...summary } = stats;
console.log(JSON.stringify({ ...summary, langs: langs.map((l) => l.name) }, null, 2));
