// Every row of test/oracle-table.mjs through `why`, without Claude Code: the same rows are put to the
// real binary by test/oracle.test.mjs, so a row that passes both is a pair on which this tool and
// Claude Code agree.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rows } from "./oracle-table.mjs";
import { describeRow, engineRun, expectedFor } from "./table-lib.mjs";

test("the table is well formed", () => {
  assert.ok(rows.length >= 40, `${rows.length} rows`);
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, rows.length, "ids are unique");
  for (const r of rows) {
    assert.ok(["allow", "ask", "deny"].includes(r.expect), r.id);
    assert.ok(!r.posix || ["allow", "ask", "deny"].includes(r.posix), r.id);
    assert.ok(["Bash", "PowerShell", "Read", "Edit", "Write", "WebFetch"].includes(r.tool), r.id);
  }
  const bash = rows.filter((r) => r.tool === "Bash").length;
  assert.ok(bash >= 300, `${bash} Bash rows`);
});

for (const row of rows) {
  // a few rows are about how Windows reads a path in a rule: only a Windows machine can answer them
  test(`${row.id} ${describeRow(row)} -> ${row.expect}`, { skip: row.engine && row.engine !== process.platform ? `about ${row.engine} paths` : false }, () => {
    const report = engineRun(row);
    assert.equal(report.decision.verdict, expectedFor(row), report.decision.summary);
  });
}
