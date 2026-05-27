-- One-off: Promote Adam Slipakoff to workspace owner
-- (adam.slipakoff@restorationhomes.com)

BEGIN;

UPDATE users
   SET is_owner = TRUE
 WHERE email = 'adam.slipakoff@restorationhomes.com';

COMMIT;
