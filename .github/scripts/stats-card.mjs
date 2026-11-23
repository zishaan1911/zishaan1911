// Generates assets/stats-dark.svg and assets/stats-light.svg from live GitHub data.
// Runs in GitHub Actions (see .github/workflows/stats-card.yml). No dependencies: Node 20+.
//
// Env:
//   GH_TOKEN          token for the GraphQL API (GITHUB_TOKEN works; a PAT with
//                     read:user + repo also counts private contributions)
//   GH_USER           GitHub login (defaults to the repo owner)
//   COMMITTERS_COUNTRY committers.top country slug for the national rank (default malaysia)
//   LEETCODE_USER     LeetCode username for the LeetCode rank (optional)
//   LANG_EXCLUDE_REPOS comma-separated repo names left out of the language count only
//   WAKATIME_API_KEY  optional; if set, "hours coded" comes from WakaTime instead
//                     of being estimated from commit timestamps

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const USER = process.env.GH_USER || (process.env.GITHUB_REPOSITORY || "").split("/")[0];
const WAKA = process.env.WAKATIME_API_KEY;
const OUT = process.env.OUT_DIR || "assets";
const COUNTRY = process.env.COMMITTERS_COUNTRY || "malaysia"; // committers.top country slug
const LEETCODE = process.env.LEETCODE_USER || "";
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

// Every commit the user authored on the default branch of the given repos.
async function authoredCommits(userId, repoNames) {
  const commits = [];
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
                  nodes { oid authoredDate }
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
      commits.push(...h.nodes.map((n) => ({ repo: full, oid: n.oid, t: Date.parse(n.authoredDate) })));
      after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
    } while (after);
  }
  return commits.sort((a, b) => a.t - b.t);
}

// Languages per commit, from the file extensions each commit touched. Results are cached by
// commit SHA in assets/stats-cache.json so later runs only look at new commits.
const EXT = {
  py: "Python", pyi: "Python", ipynb: "Python", pyx: "Python",
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++", h: "C++", ipp: "C++", cu: "CUDA", cuh: "CUDA",
  c: "C", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin", swift: "Swift",
  php: "PHP", vue: "Vue", svelte: "Svelte", astro: "Astro", rb: "Ruby", cs: "C#", lua: "Lua",
  v: "Verilog", sv: "SystemVerilog", vhd: "VHDL", glsl: "GLSL", frag: "GLSL", vert: "GLSL", wgsl: "WGSL",
  move: "Move", sol: "Solidity", sh: "Shell", bash: "Shell", ps1: "PowerShell", sql: "SQL",
  tex: "TeX", dart: "Dart", scala: "Scala", hs: "Haskell", ex: "Elixir", exs: "Elixir", zig: "Zig", m: "MATLAB", r: "R",
};
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|\.next|site-packages)\/|\.min\.(js|css)$/i;

function langsOfFiles(files) {
  const set = new Set();
  for (const f of files) {
    if (SKIP.test(f)) continue;
    const ext = f.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (ext && EXT[ext]) set.add(EXT[ext]);
  }
  return [...set];
}

async function commitLanguages(commits, cache) {
  const todo = commits.filter((c) => !(c.oid in cache));
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const c = todo[next++];
      const res = await fetch(`https://api.github.com/repos/${c.repo}/commits/${c.oid}`, {
        headers: { Authorization: `bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "profile-stats-card" },
      });
      if (res.status === 403 || res.status === 429) { console.warn("rate limited; using partial language data"); next = todo.length; break; }
      if (!res.ok) continue;
      const j = await res.json();
      cache[c.oid] = langsOfFiles((j.files || []).map((f) => f.filename));
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`languages: ${todo.length} new commits inspected`);
  const counts = new Map();
  for (const c of commits) for (const l of cache[c.oid] || []) counts.set(l, (counts.get(l) || 0) + 1);
  return counts;
}

// Session-based estimate using the git-hours defaults: commits less than 2h apart belong to
// one session and the gap counts as coding time; each new session adds 2h for the work
// done before its first commit.
function estimateHours(times) {
  const MAX_GAP = 2 * 3600e3;
  const FIRST = 2 * 3600e3;
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

// Percentile: where the past year's contributions fall among a random sample of GitHub
// accounts with at least one contribution in the past year (contrib-sample.json, built by
// sampling random user ids through the GitHub API).
function rank(contribs) {
  const sample = JSON.parse(readFileSync(new URL("./contrib-sample.json", import.meta.url), "utf8")).active;
  const atOrAbove = sample.filter((c) => c >= contribs).length;
  const percentile = Math.max(0.1, (atOrAbove / sample.length) * 100);
  const levels = [[1, "S"], [5, "A+"], [12.5, "A"], [25, "A-"], [37.5, "B+"], [50, "B"], [62.5, "B-"], [75, "C+"], [100, "C"]];
  return { percentile, level: levels.find(([t]) => percentile <= t)[1], sampleSize: sample.length };
}

// National rank from committers.top (their public badge carries the current position).
async function countryRank() {
  try {
    const res = await fetch(`https://user-badge.committers.top/${COUNTRY}/${USER}.svg`);
    const m = (await res.text()).match(/#(\d+)/);
    return m ? +m[1] : null;
  } catch { return null; }
}

async function leetcode() {
  if (!LEETCODE) return null;
  try {
    const res = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com", "User-Agent": "profile-stats-card" },
      body: JSON.stringify({
        query: `query($u: String!) { matchedUser(username: $u) { profile { ranking } submitStatsGlobal { acSubmissionNum { difficulty count } } } }`,
        variables: { u: LEETCODE },
      }),
    });
    const u = (await res.json()).data?.matchedUser;
    if (!u) return null;
    const by = Object.fromEntries(u.submitStatsGlobal.acSubmissionNum.map((x) => [x.difficulty, x.count]));
    return { ranking: u.profile.ranking, solved: by.All, easy: by.Easy, medium: by.Medium, hard: by.Hard };
  } catch { return null; }
}

// ---------- render ----------

const THEMES = {
  dark: { bg: "#0d1117", border: "#30363d", text: "#c9d1d9", strong: "#f0f6fc", muted: "#8b949e", accent: "#39d353", accent2: "#26a641", track: "#161b22" },
  light: { bg: "#ffffff", border: "#d0d7de", text: "#1f2328", strong: "#1f2328", muted: "#656d76", accent: "#2da44e", accent2: "#1a7f37", track: "#ebedf0" },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : Math.round(n).toLocaleString("en-US"));

function render(s, t) {
  const W = 804, H = 352;
  const mono = "system-ui, -apple-system, sans-serif";
  const sans = "system-ui, -apple-system, sans-serif";

  // rank ring
  const R = 46, C = 2 * Math.PI * R;
  const filled = Math.max(0.02, Math.min(1, 1 - s.rank.percentile / 100));
  const ring = `
    <g transform="translate(100 168)">
      <circle r="${R}" fill="none" stroke="${t.track}" stroke-width="8"/>
      <circle r="${R}" fill="none" stroke="${t.accent}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${(C * filled).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90)" class="ring"/>
      <text y="10" text-anchor="middle" font-family="${sans}" font-size="30" font-weight="600" fill="${t.strong}">${s.rank.level}</text>
      <text y="${R + 32}" text-anchor="middle" font-family="${mono}" font-size="13" font-weight="600" fill="${t.accent}">top ${s.rank.percentile < 10 ? s.rank.percentile.toFixed(1) : Math.round(s.rank.percentile)}%</text>
      <text y="${R + 50}" text-anchor="middle" font-family="${mono}" font-size="11" fill="${t.muted}">of active devs</text>
    </g>`;

  // stat grid: 3 columns x 3 rows
  const items = [
    ["contributions", fmt(s.totalContributions), "all time"],
    ["current streak", `${s.streak.current}d`, s.streak.current ? "keep going" : "start today"],
    ["longest streak", `${s.streak.longest}d`, "best run"],
    ["hours coded", fmt(s.hours), s.hoursSource],
    ["commits", fmt(s.commitsYear), "past year"],
    ["stars earned", fmt(s.stars), `${s.repos} repos`],
    [`rank in ${COUNTRY}`, s.countryRank ? `#${s.countryRank}` : "n/a", "committers.top"],
    ["leetcode rank", s.leetcode ? `#${s.leetcode.ranking.toLocaleString("en-US")}` : "n/a", "global"],
    ["leetcode solved", s.leetcode ? fmt(s.leetcode.solved) : "n/a", s.leetcode ? `${s.leetcode.easy}e ${s.leetcode.medium}m ${s.leetcode.hard}h` : ""],
    ["pull requests", fmt(s.prs), "opened"],
    ["issues", fmt(s.issues), "opened"],
    ["followers", fmt(s.followers), "on GitHub"],
  ];
  const grid = items
    .map(([label, value, sub], i) => {
      const x = 210 + (i % 3) * 196, y = 70 + Math.floor(i / 3) * 62;
      return `<g transform="translate(${x} ${y})" class="fade" style="animation-delay:${(i * 60)}ms">
        <text font-family="${mono}" font-size="11" fill="${t.muted}">${esc(label)}</text>
        <text y="27" font-family="${sans}" font-size="22" font-weight="600" fill="${t.strong}">${esc(value)}</text>
      </g>`;
    })
    .join("");

  // top languages bar
  const langTotal = s.langs.reduce((a, l) => a + l.size, 0) || 1;
  let lx = 16;
  const bar = s.langs
    .map((l) => {
      const w = Math.max(2, (l.size / langTotal) * 772);
      const r = `<rect x="${lx.toFixed(1)}" y="312" width="${w.toFixed(1)}" height="8" fill="${l.color || t.muted}"/>`;
      lx += w;
      return r;
    })
    .join("");
  let tx = 16;
  const legend = s.langs
    .map((l) => {
      const label = `${l.name} ${((l.size / langTotal) * 100).toFixed(0)}%`;
      const g = `<circle cx="${tx + 4}" cy="333" r="4" fill="${l.color || t.muted}"/><text x="${tx + 13}" y="337" font-family="${mono}" font-size="11" fill="${t.muted}">${esc(label)}</text>`;
      tx += label.length * 6.3 + 28;
      return g;
    })
    .join("");

  const updated = new Date().toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 10}" viewBox="0 0 ${W} ${H + 10}" role="img" aria-label="${esc(USER)} GitHub stats: ${s.totalContributions} contributions, ${s.streak.current} day streak, top ${s.rank.percentile.toFixed(1)}% of active developers">
  <defs>
    <clipPath id="bar"><rect x="16" y="312" width="772" height="8" rx="2"/></clipPath>
    <style>
      .fade { opacity: 0; animation: fade .5s ease-out forwards; }
      .ring { animation: ring 1.2s ease-out both; }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ring { from { stroke-dasharray: 0 ${C.toFixed(1)}; } }
      @media (prefers-reduced-motion: reduce) { .fade, .ring { animation: none; opacity: 1; } }
    </style>
  </defs>
  <rect x=".5" y=".5" width="${W - 1}" height="${H + 9}" rx="6" fill="${t.bg}" stroke="${t.border}"/>
  <text x="16" y="30" font-family="${sans}" font-size="14" font-weight="600" fill="${t.text}">GitHub stats</text>
  <text x="${W - 16}" y="30" text-anchor="end" font-family="${sans}" font-size="10" fill="${t.text}" opacity="0.6">@${esc(USER)} · updated ${updated}</text>
  ${ring}
  ${grid}
  <g clip-path="url(#bar)">${bar}</g>
  ${legend}
</svg>
`;
}

// ---------- main ----------

const user = await profile();
const [repos, contributed, cal] = await Promise.all([ownedRepos(), contributedRepos(), calendar(user.createdAt)]);

const names = [...new Set([...repos.map((r) => r.nameWithOwner), ...contributed.map((r) => r.nameWithOwner)])];
const commits = await authoredCommits(user.id, names);

// Top languages, counted by commits: each commit counts once for every language whose files it touched.
const CACHE = `${OUT}/stats-cache.json`;
const cache = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
const colors = { CUDA: "#3A4E3A", SystemVerilog: "#DAE1C2", Verilog: "#b2b7f8", WGSL: "#1a5e9a" };
for (const r of repos) for (const e of r.languages.edges) colors[e.node.name] ||= e.node.color;
const langExclude = new Set((process.env.LANG_EXCLUDE_REPOS || "").split(",").map((r) => r.trim().toLowerCase()).filter(Boolean));
const langCounts = await commitLanguages(commits.filter((c) => !langExclude.has(c.repo.split("/")[1].toLowerCase())), cache);
const langs = [...langCounts.entries()]
  .map(([name, n]) => ({ name, size: n, color: colors[name] }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 6);

let hours, hoursSource;
if (WAKA) {
  try { hours = await wakatimeHours(); hoursSource = "wakatime"; } catch (e) { console.warn(String(e)); }
}
if (hours === undefined) {
  hours = estimateHours(commits.map((c) => c.t));
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
const pastYear = cal.days.slice(-365).reduce((a, [, c]) => a + c, 0);
stats.rank = rank(pastYear);
[stats.countryRank, stats.leetcode] = await Promise.all([countryRank(), leetcode()]);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats-dark.svg`, render(stats, THEMES.dark));
await writeFile(`${OUT}/stats-light.svg`, render(stats, THEMES.light));
await writeFile(CACHE, JSON.stringify(cache));
const { days, langs: _l, ...summary } = stats;
console.log(JSON.stringify({ ...summary, langs: langs.map((l) => `${l.name} ${l.size}`) }, null, 2));
