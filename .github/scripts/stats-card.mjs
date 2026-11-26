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
                  nodes { oid authoredDate additions }
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
      commits.push(...h.nodes.map((n) => ({ repo: full, oid: n.oid, t: Date.parse(n.authoredDate), add: n.additions })));
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

// Longest single coding session under the same rules as estimateHours: commits less than
// 2h apart form one session, plus 2h of lead-in before its first commit.
function longestSession(times) {
  let best = 0, start = times[0];
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || times[i] - times[i - 1] >= 2 * 3600e3) {
      best = Math.max(best, (times[i - 1] - start) / 3600e3 + 2);
      start = times[i];
    }
  }
  return best;
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
  dark: { bg: "#141414", cell: "#232323", rule: "#2e2e2e", label: "#8a8a8a", text: "#f4f4f4", muted: "#8a8a8a", red: "#e8372c", onRed: "#ffffff" },
  light: { bg: "#f4f1ea", cell: "#e4dfd3", rule: "#d9d4c8", label: "#77736b", text: "#141414", muted: "#8f8a80", red: "#e8372c", onRed: "#ffffff" },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : Math.round(n).toLocaleString("en-US"));
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : fmt(n));
const rankFmt = (n) => (n >= 10000 ? `#${Math.round(n / 1000)}k` : `#${n.toLocaleString("en-US")}`);

// Swiss layout: red rank panel on the left, a strict 3x3 grid of stats on the right,
// languages as a single typographic line along the bottom.
function render(s, t) {
  const W = 804, H = 472, P = 230; // P = width of the red panel
  const font = "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif";
  const pct = s.rank.percentile < 10 ? s.rank.percentile.toFixed(1) : Math.round(s.rank.percentile);

  const cells = [
    ["CONTRIBUTIONS", fmt(s.totalContributions)],
    ["HOURS CODED", fmt(s.hours)],
    ["LINES WRITTEN", big(s.lines)],
    ["BEST DAY", fmt(s.bestDay)],
    ["STREAK", `${s.streak.current}d`],
    ["LONGEST STREAK", `${s.streak.longest}d`],
    ["PULL REQ.", fmt(s.prs)],
    ["STARS", fmt(s.stars)],
    [`${COUNTRY.toUpperCase()}`, s.countryRank ? `#${s.countryRank}` : "—"],
    ["LEETCODE", s.leetcode ? rankFmt(s.leetcode.ranking) : "—"],
    ["SOLVED", s.leetcode ? fmt(s.leetcode.solved) : "—"],
    ["LONGEST SESSION", `${Math.round(s.longestSession)}h`],
  ];
  const COLS = 4, cw = (W - P) / COLS, ch = 96;
  const grid = cells
    .map(([label, value], i) => {
      const x = P + (i % COLS) * cw, y = Math.floor(i / COLS) * ch;
      return `<g class="fade" style="animation-delay:${i * 45}ms">
      <text x="${(x + 18).toFixed(1)}" y="${y + 30}" font-size="9.5" font-weight="700" letter-spacing="1.3" fill="${t.label}">${esc(label)}</text>
      <text x="${(x + 16).toFixed(1)}" y="${y + 76}" font-size="34" font-weight="800" letter-spacing="-1.2" fill="${t.text}">${esc(value)}</text>
    </g>`;
    })
    .join("\n    ");
  const rules = [1, 2, 3].map((k) => `<line x1="${(P + k * cw).toFixed(1)}" y1="0" x2="${(P + k * cw).toFixed(1)}" y2="${3 * ch}"/>`).join("")
    + [1, 2, 3].map((k) => `<line x1="${P}" y1="${k * ch}" x2="${W}" y2="${k * ch}"/>`).join("");

  // heatmap: past 53 weeks, Sunday-first columns like GitHub, red ramp by quartile
  const today = s.days[s.days.length - 1][0];
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const span = s.days.slice(-(52 * 7 + dow + 1));
  const nz = span.map(([, c]) => c).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (f) => nz[Math.floor(f * (nz.length - 1))] || 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (c) => (c === 0 ? 0 : c <= cuts[0] ? 1 : c <= cuts[1] ? 2 : c <= cuts[2] ? 3 : 4);
  const hx = P + 18, hy = 334, pitch = (W - P - 36 + 2) / 53, cs = pitch - 2;
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  let monthLabels = "", lastMonth = -1, lastCol = -9;
  const cellsSvg = span
    .map(([date, c], i) => {
      const col = Math.floor(i / 7), row = i % 7, l = level(c);
      const m = +date.slice(5, 7) - 1;
      if (row === 0 && m !== lastMonth) {
        lastMonth = m;
        if (col - lastCol < 4 || col > 50) return cell(l, col, row);
        lastCol = col;
        monthLabels += `<text x="${(hx + col * pitch).toFixed(1)}" y="${hy - 8}">${months[m]}</text>`;
      }
      return cell(l, col, row);
    })
    .join("");
  function cell(l, col, row) {
      return `<rect x="${(hx + col * pitch).toFixed(1)}" y="${(hy + row * pitch).toFixed(1)}" width="${cs.toFixed(1)}" height="${cs.toFixed(1)}" rx="1" fill="${l ? t.red : t.cell}"${l ? ` fill-opacity="${[0, 0.3, 0.55, 0.8, 1][l]}"` : ""}/>`;
  }

  // languages: top three in full ink, the rest muted
  const total = s.langs.reduce((a, l) => a + l.size, 0) || 1;
  let lx = P + 18;
  const langs = s.langs
    .map((l, i) => {
      const label = `${l.name} ${Math.round((l.size / total) * 100)}`;
      const out = `<text x="${lx.toFixed(1)}" y="${H - 22}" fill="${i < 3 ? t.text : t.muted}">${esc(label)}</text>`;
      lx += label.length * 6.6 + 22;
      return out;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(USER)} GitHub stats: top ${pct}% of active developers, ${s.totalContributions} contributions, ${s.streak.current} day streak">
  <style>
    .fade { opacity: 0; animation: fade .5s ease-out forwards; }
    @keyframes fade { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .fade { animation: none; opacity: 1; } }
  </style>
  <g font-family="${font}">
    <rect width="${W}" height="${H}" rx="4" fill="${t.bg}"/>
    <rect width="${P}" height="${H}" rx="4" fill="${t.red}"/>
    <rect x="${P - 30}" width="30" height="${H}" fill="${t.red}"/>
    <text x="28" y="44" font-size="11" font-weight="700" letter-spacing="1.5" fill="${t.onRed}" opacity=".85">GITHUB / ${s.year}</text>
    <text x="22" y="244" font-size="168" font-weight="800" letter-spacing="-8" fill="${t.onRed}">${esc(s.rank.level)}</text>
    <text x="28" y="300" font-size="30" font-weight="800" letter-spacing="-1" fill="${t.onRed}">Top ${pct}%</text>
    <text x="28" y="322" font-size="11" font-weight="600" fill="${t.onRed}" opacity=".8">of active developers</text>
    <text x="28" y="${H - 22}" font-size="11" font-weight="700" fill="${t.onRed}">@${esc(USER)}</text>
    <g stroke="${t.rule}">${rules}</g>
    ${grid}
    <g font-size="9.5" font-weight="700" letter-spacing="1.3" fill="${t.label}">${monthLabels}</g>
    <g>${cellsSvg}</g>
    <line x1="${P}" y1="${H - 52}" x2="${W}" y2="${H - 52}" stroke="${t.rule}"/>
    <g font-size="11" font-weight="700">${langs}<text x="${W - 18}" y="${H - 22}" text-anchor="end" fill="${t.red}">%</text></g>
  </g>
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
stats.longestSession = longestSession(commits.map((c) => c.t));
// Lines written: additions on the default branch, same repos as the language count.
stats.lines = commits.filter((c) => !langExclude.has(c.repo.split("/")[1].toLowerCase())).reduce((a, c) => a + (c.add || 0), 0);
stats.bestDay = cal.days.reduce((m, [, c]) => Math.max(m, c), 0);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats-dark.svg`, render(stats, THEMES.dark));
await writeFile(`${OUT}/stats-light.svg`, render(stats, THEMES.light));
await writeFile(CACHE, JSON.stringify(cache));
const { days, langs: _l, ...summary } = stats;
console.log(JSON.stringify({ ...summary, langs: langs.map((l) => `${l.name} ${l.size}`) }, null, 2));
