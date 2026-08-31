import { randomUUID } from 'node:crypto';
import { transaction } from '../db.js';
import { ControlError } from '../control/errors.js';

const fail = (message) => { throw new ControlError('ORGANIZATION_REFUSED', message, 409); };
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240)
    fail('Use a name between 1 and 240 characters.');
  return value.trim();
}
export function readOrganization(db) {
  return { groups: db.prepare('SELECT * FROM wave_groups ORDER BY created_at, id').all(),
    waves: db.prepare('SELECT * FROM wave_organization ORDER BY session_id').all() };
}
export function changeOrganization(db, args) {
  return transaction(db, () => {
    const { action, sessionId, groupId } = args;
    if (action === 'group.create') {
      db.prepare('INSERT INTO wave_groups VALUES (?, ?, ?)').run(`group_${randomUUID()}`, name(args.name), new Date().toISOString());
    } else if (action === 'group.rename') {
      // A default Hermes group may be named without changing Hermes' own title.
      if (typeof groupId !== 'string' || groupId.length > 256 || !groupId) fail('Unknown group.');
      const known = db.prepare('SELECT 1 FROM wave_groups WHERE id = ?').get(groupId)
        || db.prepare('SELECT 1 FROM session_watches WHERE hermes_session_id = ?').get(groupId)
        || (groupId.startsWith('unlinked:') && db.prepare('SELECT 1 FROM autonomous_sessions WHERE id = ?').get(groupId.slice(9)));
      if (!known) fail('Unknown group.');
      db.prepare('INSERT INTO wave_groups VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
        .run(groupId, name(args.name), new Date().toISOString());
    } else if (action === 'group.delete') {
      if (typeof groupId !== 'string' || !groupId.startsWith('group_')) fail('Only custom groups can be removed.');
      db.prepare('UPDATE wave_organization SET group_id=NULL WHERE group_id=?').run(groupId);
      db.prepare('DELETE FROM wave_groups WHERE id=?').run(groupId);
    } else {
      if (!['rename', 'move', 'archive', 'restore', 'delete'].includes(action)) fail('Unknown organization action.');
      const session = db.prepare('SELECT * FROM autonomous_sessions WHERE id=?').get(sessionId);
      if (!session) fail('Unknown wave.');
      const prior = db.prepare('SELECT * FROM wave_organization WHERE session_id=?').get(sessionId);
      if (prior?.deleted_at) {
        if (action === 'delete') return readOrganization(db);
        fail('This wave was deleted from the organizer.');
      }
      if (['archive', 'delete'].includes(action)) {
        const settled = ['FAILED', 'COMPLETED'].includes(session.state)
          || (session.state === 'SEMANTICALLY_ACCEPTED' && ['MANUAL', 'PLAN'].includes(session.mode));
        if (!settled) fail('Finish or stop this wave before archiving it.');
        // A terminal envelope can precede process teardown. Never hide live family work.
        if (session.job_id) {
          const open = db.prepare(`WITH RECURSIVE family(id) AS (
            SELECT id FROM jobs WHERE id = ? UNION ALL
            SELECT j.id FROM jobs j JOIN family f ON j.parent_job_id = f.id
          ) SELECT 1 FROM attempts WHERE job_id IN (SELECT id FROM family) AND terminal_state IS NULL
          UNION ALL SELECT 1 FROM work_commissions WHERE job_id IN (SELECT id FROM family)
            AND state IN ('PENDING','CLAIMED') LIMIT 1`).get(session.job_id);
          if (open) fail('Wait for this wave’s workers to finish stopping before archiving it.');
        }
      }
      if (action === 'delete' && (!prior?.archived_at || args.confirm !== true))
        fail('Archive the wave first and confirm deletion. Execution audit records are retained.');
      db.prepare('INSERT OR IGNORE INTO wave_organization(session_id) VALUES (?)').run(sessionId);
      if (action === 'rename') db.prepare('UPDATE wave_organization SET name=? WHERE session_id=?').run(name(args.name), sessionId);
      if (action === 'move') {
        if (groupId !== null && (typeof groupId !== 'string' || !(
          db.prepare('SELECT 1 FROM wave_groups WHERE id=?').get(groupId)
          || db.prepare('SELECT 1 FROM session_watches WHERE hermes_session_id=?').get(groupId)
          || (groupId.startsWith('unlinked:') && db.prepare('SELECT 1 FROM autonomous_sessions WHERE id=?').get(groupId.slice(9)))))) fail('Unknown destination group.');
        db.prepare('UPDATE wave_organization SET group_id=? WHERE session_id=?').run(groupId, sessionId);
      }
      if (action === 'archive') db.prepare('UPDATE wave_organization SET archived_at=COALESCE(archived_at,?) WHERE session_id=?').run(new Date().toISOString(),sessionId);
      if (action === 'restore') db.prepare('UPDATE wave_organization SET archived_at=NULL WHERE session_id=?').run(sessionId);
      if (action === 'delete') db.prepare('UPDATE wave_organization SET deleted_at=? WHERE session_id=?').run(new Date().toISOString(),sessionId);
    }
    return readOrganization(db);
  });
}
