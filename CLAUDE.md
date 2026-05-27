# PropSpot — project notes

## Deploy = push
Railway auto-deploys this repo from the `main` branch of
`jordanshutts-cpu/propspot`. Pushing **is** deploying.

## Auto-push after each completed task
Override the global "ask before commit/push" rule **for this repo only**:

- When a coherent task is finished and the change works (tests/lint pass,
  no obvious red flags), commit and push without asking.
- A "task" is the user's end-to-end ask, not every individual Edit. Bundle
  related edits into one commit.
- Skip when: the work is incomplete, an investigation didn't produce a real
  fix, or anything destructive is involved (DB writes, force-push, deletions
  outside the working set) — still confirm those.
- Skip when: the only changes are dead-ends, debug prints, or scratch files.
- Use `git pull --rebase origin main && git push origin main` so concurrent
  pushes from elsewhere don't fail the push.
- Commit messages: follow this repo's style (imperative subject, optional
  body explaining why). Include the standard `Co-Authored-By` trailer.
- After pushing, state the short SHA in the response so the user can match
  it to the Railway deploy.

## Database
- Prod Postgres lives on Railway (DATABASE_URL in `propspot-os/.env`).
- Never echo, log, or commit the DATABASE_URL or any secrets.
- DB schema is at `propspot-os/db/schema.sql`.
- One-off SQL audit trail: `propspot-os/db/one-off/`.
- For destructive prod DB operations (DELETE, UPDATE of user data, schema
  changes), still confirm with the user before running. Auto-push covers
  code, not data.
