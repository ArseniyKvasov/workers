import { describe, expect, it } from "vitest";
import { D1Binding } from "./d1.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeBinding() {
  const dir = mkdtempSync(join(tmpdir(), "d1-test-"));
  return new D1Binding("wkr_test", "db", join(dir, "test.db"));
}

describe("D1Binding", () => {
  it("executes DDL and DML through prepare/bind/run", async () => {
    const db = makeBinding();
    await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

    await db
      .prepare("INSERT INTO users (name) VALUES (?)")
      .bind("alice")
      .run();
    await db
      .prepare("INSERT INTO users (name) VALUES (?)")
      .bind("bob")
      .run();

    const result = await db.prepare("SELECT * FROM users ORDER BY id").all();
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]).toMatchObject({ id: 1, name: "alice" });

    const first = await db.prepare("SELECT name FROM users WHERE id = ?").bind(2).first<{ name: string }>("name");
    expect(first).toBe("bob");
    await db.close();
  });

  it("supports batch execution", async () => {
    const db = makeBinding();
    await db.exec("CREATE TABLE t (v INTEGER)");
    const results = await db.batch([
      db.prepare("INSERT INTO t (v) VALUES (?)").bind(1),
      db.prepare("INSERT INTO t (v) VALUES (?)").bind(2),
      db.prepare("SELECT COUNT(*) AS c FROM t"),
    ]);
    expect(results.length).toBe(3);
    expect((results[2]!.rows[0] as Record<string, unknown>).c).toBe(2);
    await db.close();
  });

  it("reports rows read/written via hooks", async () => {
    const read: number[] = [];
    const written: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "d1-test-"));
    const db = new D1Binding("wkr_test", "db", join(dir, "test.db"), {
      onRowsRead: (_w, rows) => read.push(rows),
      onRowsWritten: (_w, rows) => written.push(rows),
    });

    await db.exec("CREATE TABLE t (v INTEGER)");
    await db.batch([db.prepare("INSERT INTO t (v) VALUES (1)")]);
    await db.prepare("SELECT * FROM t").all();

    expect(written.length).toBeGreaterThan(0);
    expect(read).toContain(1);
    await db.close();
  });
});
