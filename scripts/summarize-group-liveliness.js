// Offline summary of manually stored randomized-label ratings. No API calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dir = path.resolve(process.argv[2]);
const run = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(dir, "blind-review.json"), "utf8"));
const ratings = JSON.parse(fs.readFileSync(path.join(dir, "ratings.json"), "utf8"));
const controls = new Set(["replay-h44", "replay-h49", "replay-h61", "new-code-help", "new-search-teaching"]);
const totals = () => ({ n: 0, sum: 0, scoreCounts: [0,0,0,0,0] });
const summary = { reviewer: ratings.reviewer, rubric: ratings.rubric, criteriaUpdate: ratings.criteriaUpdate,
  attributionLimit: run.attributionLimit, requests: run.results.length,
  errors: run.results.filter(row => row.error || row.finishReason === "length").length,
  A: { all: totals(), casual: totals(), controls: totals(), promptTokens: 0, completionTokens: 0 },
  B: { all: totals(), casual: totals(), controls: totals(), promptTokens: 0, completionTokens: 0 },
  preference: { all: { A:0, B:0, ties:0 }, casual: { A:0, B:0, ties:0 }, controls: { A:0, B:0, ties:0 } } };
assert.equal(ratings.ratings.length, review.reviews.length);
for (const judgement of ratings.ratings) {
  const map = run.blindMapping.find(row => row.reviewId === judgement.reviewId);
  const pair = review.reviews.find(row => row.reviewId === judgement.reviewId);
  assert.ok(map && pair);
  const scope = controls.has(pair.caseId) ? "controls" : "casual";
  for (const slot of ["X", "Y"]) {
    const score = judgement[slot];
    assert.ok(Number.isInteger(score) && score >= 0 && score <= 4);
    for (const group of ["all", scope]) {
      const bucket = summary[map[slot]][group];
      bucket.n++; bucket.sum += score; bucket.scoreCounts[score]++;
    }
  }
  const preferred = judgement.X === judgement.Y ? "ties" : map[judgement.X > judgement.Y ? "X" : "Y"];
  summary.preference.all[preferred]++; summary.preference[scope][preferred]++;
}
for (const row of run.results) {
  summary[row.variant].promptTokens += row.usage?.prompt_tokens || 0;
  summary[row.variant].completionTokens += row.usage?.completion_tokens || 0;
}
for (const arm of ["A", "B"]) for (const scope of ["all", "casual", "controls"]) {
  summary[arm][scope].mean = summary[arm][scope].n ? summary[arm][scope].sum / summary[arm][scope].n : null;
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
