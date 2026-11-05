// Re-queues failed fee deposits (build plan §10.6): sets them from `failed` back to `pending`
// so the running gateway's deposit worker tries again.
//
//   pnpm --filter @defect/gateway deposit:retry <attemptId> [<attemptId> …]
//   pnpm --filter @defect/gateway deposit:retry --all
import { join } from "node:path";
import { Db } from "../src/db";

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("Usage: pnpm --filter @defect/gateway deposit:retry <attemptId…> | --all");
  process.exit(1);
}
const db = new Db(join(process.env.GATEWAY_DATA_DIR ?? "./data", "defect.db"));
const changes = ids.includes("--all")
  ? db.run("UPDATE attempts SET deposit_status = 'pending', deposit_tries = 0, deposit_next_at = NULL WHERE deposit_status = 'failed'").changes
  : ids.reduce(
      (n, id) =>
        n +
        db.run("UPDATE attempts SET deposit_status = 'pending', deposit_tries = 0, deposit_next_at = NULL WHERE attempt_id = ? AND deposit_status = 'failed'", [id])
          .changes,
      0,
    );
console.log(`Re-queued ${changes} deposit(s).`);
db.close();
